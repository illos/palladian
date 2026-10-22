import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  atLeast,
  fail,
  hasOwnerAuthority,
  loadNote,
  notebookRole,
  requireHuman,
  requirePrincipal,
} from "./access";
import { nextSeq } from "./documents";
import { scheduleNoteSync } from "./references";

const DAY_MS = 86_400_000;
export const RETENTION_CHOICES = [1, 7, 30, 90, 0] as const;
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Permanently delete a note and its entire history. Steps are removed in
 * scheduled batches; everything that reveals content is removed now.
 */
async function purge(ctx: MutationCtx, note: Doc<"notes">) {
  const content = await ctx.db
    .query("noteContent")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .unique();
  if (content) await ctx.db.delete(content._id);
  const text = await ctx.db
    .query("noteText")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .unique();
  if (text) await ctx.db.delete(text._id);
  for (const grant of await ctx.db
    .query("noteMembers")
    .withIndex("by_note_and_principal", (q) => q.eq("noteId", note._id))
    .take(500))
    await ctx.db.delete(grant._id);
  for (const link of await ctx.db
    .query("publicLinks")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .take(100))
    await ctx.db.delete(link._id);
  // Everyone's pins and custom positions for the note (D102), in batches
  // after this transaction; until then reads leave them out.
  await ctx.scheduler.runAfter(0, internal.arrangement.forgetStale, {
    noteId: note._id,
  });
  await ctx.db.insert("noteTombstones", {
    notebookId: note.notebookId,
    noteId: note._id,
    seq: await nextSeq(ctx, note.notebookId),
  });
  await ctx.db.delete(note._id);
  await ctx.scheduler.runAfter(0, internal.lifecycle.purgeHistory, {
    noteId: note._id,
  });
  // Its object references, in batches; objects only it ever used are
  // permanently deleted with it (files.syncNote).
  await scheduleNoteSync(ctx, note._id);
}

/** Remove history rows in batches after a note is permanently deleted. */
export const purgeHistory = internalMutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let removed = 0;
    for (const table of [
      "noteSteps",
      "noteCheckpoints",
      "noteVersions",
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_note_and_revision", (q) => q.eq("noteId", args.noteId))
        .take(400 - removed);
      for (const row of rows) await ctx.db.delete(row._id);
      removed += rows.length;
      if (removed >= 400) break;
    }
    if (removed >= 400)
      await ctx.scheduler.runAfter(0, internal.lifecycle.purgeHistory, args);
    return null;
  },
});

export const deleteForever = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (!hasOwnerAuthority(actor, note.ownerId, "delete"))
      fail(
        "denied",
        "Only the owner, or an agent they delegated, can delete notes permanently.",
      );
    if (note.lifecycle !== "trashed")
      fail("invalid", "Move the note to Trash before deleting it permanently.");
    await purge(ctx, note);
    return null;
  },
});

export const setTrashRetention = mutation({
  args: { days: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (!(RETENTION_CHOICES as readonly number[]).includes(args.days))
      fail("invalid", "Choose 1, 7, 30 or 90 days, or forever.");
    await ctx.db.patch(person._id, { trashRetentionDays: args.days });
    return null;
  },
});

/** Daily: permanently delete Trash older than each owner's current retention. */
export const purgeExpired = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("notes")
      .withIndex("by_lifecycle_and_trashed_at", (q) =>
        q.eq("lifecycle", "trashed").lt("trashedAt", now - DAY_MS),
      )
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    const retention = new Map<Id<"principals">, number>();
    for (const note of page.page) {
      if (!retention.has(note.ownerId)) {
        const owner = await ctx.db.get(note.ownerId);
        retention.set(
          note.ownerId,
          owner?.trashRetentionDays ?? DEFAULT_RETENTION_DAYS,
        );
      }
      const days = retention.get(note.ownerId)!;
      if (days > 0 && (note.trashedAt ?? now) <= now - days * DAY_MS)
        await purge(ctx, note);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.lifecycle.purgeExpired, {
        cursor: page.continueCursor,
      });
    return null;
  },
});

async function accessLoss(
  ctx: QueryCtx | MutationCtx,
  note: Doc<"notes">,
  destination: Id<"notebooks">,
) {
  const lost: { principalId: Id<"principals">; name: string }[] = [];
  if (note.restricted) return lost;
  const members = await ctx.db
    .query("notebookMembers")
    .withIndex("by_notebook_and_principal", (q) =>
      q.eq("notebookId", note.notebookId),
    )
    .take(200);
  for (const member of members) {
    const explicit = await ctx.db
      .query("noteMembers")
      .withIndex("by_note_and_principal", (q) =>
        q.eq("noteId", note._id).eq("principalId", member.principalId),
      )
      .unique();
    if (explicit) continue;
    const stays = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", destination).eq("principalId", member.principalId),
      )
      .unique();
    if (stays) continue;
    const principal = await ctx.db.get(member.principalId);
    lost.push({
      principalId: member.principalId,
      name: principal?.name ?? "Unknown",
    });
  }
  return lost;
}

/** Who would lose access if the note moved; shown before confirming. */
export const movePreview = query({
  args: { noteId: v.id("notes"), notebookId: v.id("notebooks") },
  returns: v.array(
    v.object({ principalId: v.id("principals"), name: v.string() }),
  ),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (!hasOwnerAuthority(actor, note.ownerId, "move")) return [];
    return await accessLoss(ctx, note, args.notebookId);
  },
});

/** Move between the owner's notebooks, keeping ID, history and explicit grants. */
export const move = mutation({
  args: { noteId: v.id("notes"), notebookId: v.id("notebooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (!hasOwnerAuthority(actor, note.ownerId, "move"))
      fail(
        "denied",
        "Only the owner, or an agent they delegated, can move notes.",
      );
    if (note.notebookId === args.notebookId) return null;
    const destination = await ctx.db.get(args.notebookId);
    if (!destination || destination.ownerId !== note.ownerId)
      fail(
        "invalid",
        "Notes can only move between notebooks with the same owner.",
      );
    if (!atLeast(await notebookRole(ctx, actor, destination), "edit"))
      fail("denied", "You cannot add notes to that notebook.");
    await ctx.db.insert("noteTombstones", {
      notebookId: note.notebookId,
      noteId: note._id,
      seq: await nextSeq(ctx, note.notebookId),
    });
    await ctx.db.patch(note._id, {
      notebookId: destination._id,
      seq: await nextSeq(ctx, destination._id),
    });
    const text = await ctx.db
      .query("noteText")
      .withIndex("by_note", (q) => q.eq("noteId", note._id))
      .unique();
    if (text) await ctx.db.patch(text._id, { notebookId: destination._id });
    // It arrives without a custom position, so it shows at the top there.
    // The old notebook's positions are removed in batches afterwards; reads
    // already ignore them.
    await ctx.scheduler.runAfter(0, internal.arrangement.forgetStale, {
      noteId: note._id,
    });
    return null;
  },
});
