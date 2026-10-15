import { docToMarkdown } from "@palladian/notes-core";
import { v } from "convex/values";
import { Transform } from "prosemirror-transform";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { fail, loadNote, requirePrincipal } from "./access";
import {
  commitSteps,
  digestOf,
  docAtRevision,
  getContent,
  receiptFor,
} from "./documents";

/** History requires edit access; readers see only current content. */
export const list = query({
  args: {
    noteId: v.id("notes"),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    versions: v.array(
      v.object({
        revision: v.number(),
        baseRevision: v.number(),
        kind: v.union(
          v.literal("create"),
          v.literal("edit"),
          v.literal("restore"),
        ),
        actorId: v.id("principals"),
        actorName: v.string(),
        actorKind: v.union(v.literal("human"), v.literal("agent")),
        startedAt: v.number(),
        endedAt: v.number(),
        deviceTime: v.union(v.number(), v.null()),
      }),
    ),
    nextBefore: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    await loadNote(ctx, principal, args.noteId, "edit");
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 30)));
    const before = args.before ?? Number.MAX_SAFE_INTEGER;
    const rows = await ctx.db
      .query("noteVersions")
      .withIndex("by_note_and_revision", (q) =>
        q.eq("noteId", args.noteId).lt("revision", before),
      )
      .order("desc")
      .take(limit);
    const names = new Map<Id<"principals">, string>();
    const versions = [];
    for (const row of rows) {
      if (!names.has(row.actorId))
        names.set(
          row.actorId,
          (await ctx.db.get(row.actorId))?.name ?? "Unknown",
        );
      versions.push({
        revision: row.revision,
        baseRevision: row.baseRevision,
        kind: row.kind,
        actorId: row.actorId,
        actorName: names.get(row.actorId)!,
        actorKind: row.actorKind,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        deviceTime: row.deviceTime ?? null,
      });
    }
    return {
      versions,
      nextBefore:
        rows.length === limit ? rows[rows.length - 1]!.revision : null,
    };
  },
});

/** Read a past revision. Browsing never changes the live note. */
export const read = query({
  args: { noteId: v.id("notes"), revision: v.number() },
  returns: v.object({
    revision: v.number(),
    markdown: v.string(),
    doc: v.string(),
  }),
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    await loadNote(ctx, principal, args.noteId, "edit");
    const content = await getContent(ctx, args.noteId);
    if (
      !Number.isSafeInteger(args.revision) ||
      args.revision < 0 ||
      args.revision > content.revision
    )
      fail("not_found", "That revision does not exist.");
    const doc = await docAtRevision(ctx, args.noteId, args.revision);
    return {
      revision: args.revision,
      markdown: docToMarkdown(doc),
      doc: JSON.stringify(doc.toJSON()),
    };
  },
});

/** Restore appends a new revision with past content; intervening history stays. */
export const restore = mutation({
  args: {
    noteId: v.id("notes"),
    revision: v.number(),
    expectedRevision: v.number(),
    requestId: v.optional(v.string()),
  },
  returns: v.object({ revision: v.number(), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "edit");
    const digest = await digestOf([
      "restore",
      args.noteId,
      args.revision,
      args.expectedRevision,
    ]);
    const prior = await receiptFor(ctx, actor, args.requestId, digest);
    if (prior) return { revision: prior.revision, replayed: true };
    const content = await getContent(ctx, note._id);
    if (content.revision !== args.expectedRevision)
      fail(
        "conflict",
        `The note changed (revision ${content.revision}, expected ${args.expectedRevision}).`,
      );
    if (
      !Number.isSafeInteger(args.revision) ||
      args.revision < 0 ||
      args.revision >= content.revision
    )
      fail("invalid", "Choose an earlier revision to restore.");
    const past = await docAtRevision(ctx, note._id, args.revision);
    const current = await docAtRevision(ctx, note._id, content.revision);
    const tr = new Transform(current).replaceWith(
      0,
      current.content.size,
      past.content,
    );
    const result = await commitSteps(ctx, {
      note,
      content,
      actor,
      steps: tr.steps,
      clientId: "restore:" + actor._id,
      kind: "restore",
    });
    if (args.requestId)
      await ctx.db.insert("receipts", {
        actorId: actor._id,
        requestId: args.requestId,
        digest,
        noteId: note._id,
        revision: result.revision,
        createdAt: Date.now(),
      });
    return { revision: result.revision, replayed: false };
  },
});
