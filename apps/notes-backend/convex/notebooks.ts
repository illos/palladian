import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  fail,
  hasOwnerAuthority,
  notebookRole,
  requireHuman,
  requirePrincipal,
  type Principal,
} from "./access";
import { moveNote } from "./lifecycle";
import { changeLifecycle } from "./notes";
import { changeRestriction } from "./sharing";

export function cleanName(name: string) {
  const value = name.trim().replace(/\s+/g, " ");
  if (!value || value.length > 100)
    fail("invalid", "Notebook names need 1 to 100 characters.");
  return value;
}
function cleanDescription(description: string) {
  const value = description.trim();
  if (value.length > 1000)
    fail("invalid", "Descriptions are limited to 1000 characters.");
  return value;
}

/** Create a notebook owned by a person; agents create them for their controller. */
export async function createNotebook(
  ctx: MutationCtx,
  actor: Principal | { _id: Id<"principals">; kind: "human" },
  name: string,
  description: string,
) {
  const ownerId =
    actor.kind === "agent" && "controllerId" in actor && actor.controllerId
      ? actor.controllerId
      : actor._id;
  const now = Date.now();
  const notebookId = await ctx.db.insert("notebooks", {
    ownerId,
    name: cleanName(name),
    description: cleanDescription(description),
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("notebookSequences", { notebookId, seq: 0 });
  if (actor._id !== ownerId)
    await ctx.db.insert("notebookMembers", {
      notebookId,
      principalId: actor._id,
      role: "edit",
      grantedBy: ownerId,
      createdAt: now,
    });
  // Agents the owner chose to share every notebook with receive ordinary memberships.
  const agents = await ctx.db
    .query("principals")
    .withIndex("by_controller", (q) => q.eq("controllerId", ownerId))
    .take(100);
  for (const agent of agents) {
    if (!agent.autoShareRole || agent.disabledAt || agent._id === actor._id)
      continue;
    await ctx.db.insert("notebookMembers", {
      notebookId,
      principalId: agent._id,
      role: agent.autoShareRole,
      grantedBy: ownerId,
      createdAt: now,
    });
  }
  return notebookId;
}

export const create = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  returns: v.id("notebooks"),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    return await createNotebook(ctx, actor, args.name, args.description ?? "");
  },
});

export const update = mutation({
  args: {
    notebookId: v.id("notebooks"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook) fail("not_found", "Notebook not found.");
    if (!hasOwnerAuthority(actor, notebook.ownerId, "share"))
      fail("denied", "Only the notebook owner can change it.");
    await ctx.db.patch(notebook._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.description !== undefined
        ? { description: cleanDescription(args.description) }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setDefault = mutation({
  args: { notebookId: v.id("notebooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    if (actor.kind !== "human") fail("denied", "Only people have defaults.");
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || notebook.ownerId !== actor._id)
      fail("not_found", "Notebook not found.");
    await ctx.db.patch(actor._id, { defaultNotebookId: notebook._id });
    return null;
  },
});

/**
 * Deleting a notebook (plan 08, A5). Only its owner, signed in as a person,
 * may delete it, and not while it is their default notebook. Its notes leave
 * first, through the ordinary move and trash paths, for another notebook the
 * owner chooses:
 *
 * - kept there as they are (`trash: false`), like moving each one; or
 * - put in Trash there (`trash: true`). Trash keeps a note's notebook, so the
 *   destination is where a restored note returns.
 *
 * A note that ends up in Trash this way, or was already there, is made
 * private (restricted) when the destination has members, so nobody gains
 * access to it through the deletion. Restricted notes stay restricted and
 * explicit per-note grants are kept, as with any move. A note owned by
 * someone else stops the deletion: the caller has no authority over it.
 *
 * Then the notebook's memberships go, its open invitations are revoked, and
 * its feed entries and the notebook itself are removed, leaving a record in
 * `deletedNotebooks` for the owner's other devices (see notes.create). Everyone's sort
 * order and custom positions for it follow in scheduled batches
 * (`arrangement.forgetNotebook`), as moved notes' positions do
 * (`arrangement.forgetStale`); reads leave them out meanwhile.
 *
 * Each call does a bounded amount of work and reports `done: false` until
 * the notebook is gone; the caller repeats it. A notebook that is already
 * gone, or that the caller cannot see, reports `done` without any change, so
 * repeating is harmless and reveals nothing.
 */
const NOTE_BATCH = 50;
const ROW_BATCH = 400;
/**
 * Bytes of search text one call may read. Measuring a note reads its search
 * text (noteText) once, moving it reads and rewrites it, and putting it in
 * Trash does so again, so a note costs its text two or three times over in
 * reads, and once or twice in writes. 8 MiB leaves half of Convex's 16 MiB
 * read and write limits for everything else, including measuring the next
 * note before stopping. One note always fits, so every call makes progress:
 * no document exceeds Convex's 1 MiB, so the largest note costs about 3 MiB
 * read and 2 MiB written.
 */
const BYTE_BUDGET = 8 * 1024 * 1024;
/** The note, its tombstone, sequence counters and feed entries. */
const NOTE_OVERHEAD = 8 * 1024;

/** The UTF-8 size of a note's search text, which a move rewrites. */
async function searchTextBytes(ctx: MutationCtx, noteId: Id<"notes">) {
  const row = await ctx.db
    .query("noteText")
    .withIndex("by_note", (q) => q.eq("noteId", noteId))
    .unique();
  return row ? new TextEncoder().encode(row.text).length : 0;
}

async function deletionTarget(
  ctx: MutationCtx,
  person: Principal,
  notebook: Doc<"notebooks">,
  destinationId: Id<"notebooks">,
) {
  if (notebook.ownerId !== person._id)
    fail("denied", "Only the notebook's owner can delete it.");
  if (person.defaultNotebookId === notebook._id)
    fail(
      "invalid",
      "This is your default notebook. Choose another default before deleting it.",
    );
  const destination =
    destinationId === notebook._id ? null : await ctx.db.get(destinationId);
  if (!destination || destination.ownerId !== person._id)
    fail("invalid", "Choose another of your notebooks for its notes.");
  return destination;
}

async function hasMembers(
  ctx: QueryCtx | MutationCtx,
  notebookId: Id<"notebooks">,
) {
  const member = await ctx.db
    .query("notebookMembers")
    .withIndex("by_notebook_and_principal", (q) =>
      q.eq("notebookId", notebookId),
    )
    .first();
  return member !== null;
}

/** How much the deletion preview examines before saying it is not exact. */
const PREVIEW_MEMBERS = 200;
const PREVIEW_NOTES = 500;
const PREVIEW_GRANTS = 5000;

/**
 * What deleting a notebook would do, shown before confirming: which of its
 * members would lose access to a note they can open now, and whether the
 * destination has members (notes in Trash then become private there).
 *
 * A member loses a note they open through the notebook (not restricted, no
 * explicit grant of theirs) when they are not a member of the destination,
 * or when the note ends up private in Trash there. Explicit grants, "No
 * access" included, keep deciding as before; restricted notes are opened
 * only through them. At most 200 members, 500 notes and 5,000 explicit
 * grants are read; when that leaves anything unexamined, or a note has more
 * than 200 grants, `complete` is false and the app says the list may not be
 * exact. Null for anyone but the owner, or an invalid
 * destination. The answer names its destination and choice, so the app can
 * tell it belongs to what is selected.
 */
export const deletePreview = query({
  args: {
    notebookId: v.id("notebooks"),
    destinationId: v.id("notebooks"),
    trash: v.boolean(),
  },
  returns: v.union(
    v.null(),
    v.object({
      destinationId: v.id("notebooks"),
      trash: v.boolean(),
      lost: v.array(
        v.object({ principalId: v.id("principals"), name: v.string() }),
      ),
      destinationShared: v.boolean(),
      complete: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || notebook.ownerId !== person._id) return null;
    const destination =
      args.destinationId === notebook._id
        ? null
        : await ctx.db.get(args.destinationId);
    if (!destination || destination.ownerId !== person._id) return null;
    const destinationShared = await hasMembers(ctx, destination._id);
    const members = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", notebook._id),
      )
      .take(PREVIEW_MEMBERS + 1);
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_notebook_and_seq", (q) => q.eq("notebookId", notebook._id))
      .take(PREVIEW_NOTES + 1);
    const candidates = members.slice(0, PREVIEW_MEMBERS);
    const staying = new Set<Id<"principals">>();
    for (const member of candidates) {
      const there = await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q
            .eq("notebookId", destination._id)
            .eq("principalId", member.principalId),
        )
        .unique();
      if (there) staying.add(member.principalId);
    }
    const losing = new Set<Id<"principals">>();
    // Notes not examined could add names; a cut-off grant list could add a
    // name wrongly. Either makes the answer inexact.
    let unexamined = notes.length > PREVIEW_NOTES;
    let grantsCut = false;
    let grantsRead = 0;
    for (const note of notes.slice(0, PREVIEW_NOTES)) {
      // Once everyone examined loses something, more notes add nothing.
      if (losing.size === candidates.length) break;
      if (note.restricted) continue;
      // Never read past the grant budget (review round 2, R2-2). When the
      // budget left cannot show that a note's grants are all read, that note
      // and the rest stay unexamined.
      const budget = Math.min(PREVIEW_MEMBERS + 1, PREVIEW_GRANTS - grantsRead);
      if (budget <= 0) {
        unexamined = true;
        break;
      }
      const grants = await ctx.db
        .query("noteMembers")
        .withIndex("by_note_and_principal", (q) => q.eq("noteId", note._id))
        .take(budget);
      grantsRead += grants.length;
      if (grants.length === budget && budget <= PREVIEW_MEMBERS) {
        unexamined = true;
        break;
      }
      if (grants.length > PREVIEW_MEMBERS) grantsCut = true;
      const explicit = new Set(grants.map((grant) => grant.principalId));
      const privateInTrash =
        destinationShared && (args.trash || note.lifecycle === "trashed");
      for (const member of candidates)
        if (
          !explicit.has(member.principalId) &&
          (privateInTrash || !staying.has(member.principalId))
        )
          losing.add(member.principalId);
    }
    const everyone = losing.size === candidates.length;
    const lost = [];
    for (const member of candidates)
      if (losing.has(member.principalId))
        lost.push({
          principalId: member.principalId,
          name: (await ctx.db.get(member.principalId))?.name ?? "Unknown",
        });
    return {
      destinationId: destination._id,
      trash: args.trash,
      lost,
      destinationShared,
      complete:
        members.length <= PREVIEW_MEMBERS &&
        !grantsCut &&
        (everyone || !unexamined),
    };
  },
});

export const remove = mutation({
  args: {
    notebookId: v.id("notebooks"),
    /** Another notebook the caller owns, where its notes go. */
    destinationId: v.id("notebooks"),
    /** Put its notes in Trash (filed in the destination) rather than keep them. */
    trash: v.boolean(),
  },
  returns: v.object({ done: v.boolean(), notes: v.number() }),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || !(await notebookRole(ctx, person, notebook)))
      return { done: true, notes: 0 };
    const destination = await deletionTarget(
      ctx,
      person,
      notebook,
      args.destinationId,
    );

    const notes = await ctx.db
      .query("notes")
      .withIndex("by_notebook_and_seq", (q) => q.eq("notebookId", notebook._id))
      .take(NOTE_BATCH);
    if (notes.length) {
      const shared = await hasMembers(ctx, destination._id);
      let spent = 0;
      let filed = 0;
      for (const note of notes) {
        if (note.ownerId !== person._id)
          fail(
            "conflict",
            "This notebook holds a note owned by someone else, so it cannot be deleted.",
          );
        const trashing = args.trash || note.lifecycle === "trashed";
        const cost =
          (await searchTextBytes(ctx, note._id)) * (trashing ? 3 : 2) +
          NOTE_OVERHEAD;
        // At least one note per call, so a call always makes progress.
        if (filed > 0 && spent + cost > BYTE_BUDGET) break;
        spent += cost;
        filed++;
        await moveNote(ctx, note, destination._id);
        let moved = (await ctx.db.get(note._id))!;
        if (args.trash || moved.lifecycle === "trashed") {
          if (shared && !moved.restricted) {
            await changeRestriction(ctx, moved, true);
            moved = (await ctx.db.get(note._id))!;
          }
          await changeLifecycle(ctx, moved, true);
        }
      }
      return { done: false, notes: filed };
    }

    let budget = ROW_BATCH;
    const members = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", notebook._id),
      )
      .take(budget);
    for (const member of members) await ctx.db.delete(member._id);
    budget -= members.length;
    if (budget > 0) {
      // Open invitations end as Revoke ends them; accepted ones stay as the
      // record of grants already made, which are removed above.
      const now = Date.now();
      const open = await ctx.db
        .query("invitations")
        .withIndex("by_notebook_and_accepted_at_and_revoked_at", (q) =>
          q
            .eq("notebookId", notebook._id)
            .eq("acceptedAt", undefined)
            .eq("revokedAt", undefined),
        )
        .take(budget);
      for (const invitation of open)
        await ctx.db.patch(invitation._id, { revokedAt: now });
      budget -= open.length;
    }
    if (budget > 0) {
      const tombstones = await ctx.db
        .query("noteTombstones")
        .withIndex("by_notebook_and_seq", (q) =>
          q.eq("notebookId", notebook._id),
        )
        .take(budget);
      for (const tombstone of tombstones) await ctx.db.delete(tombstone._id);
      budget -= tombstones.length;
    }
    if (budget <= 0) return { done: false, notes: 0 };
    const sequence = await ctx.db
      .query("notebookSequences")
      .withIndex("by_notebook", (q) => q.eq("notebookId", notebook._id))
      .unique();
    if (sequence) await ctx.db.delete(sequence._id);
    await ctx.db.delete(notebook._id);
    // Kept for good: the owner's other devices may still create notes they
    // typed in it (notes.create files them in the default notebook).
    await ctx.db.insert("deletedNotebooks", {
      notebookId: notebook._id,
      ownerId: notebook.ownerId,
      deletedAt: Date.now(),
    });
    // Everyone's sort order and positions for it go in batches afterwards;
    // reads leave them out once the notebook is gone.
    await ctx.scheduler.runAfter(0, internal.arrangement.forgetNotebook, {
      notebookId: notebook._id,
    });
    return { done: true, notes: 0 };
  },
});
