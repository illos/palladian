import { v, ConvexError } from "convex/values";
import { Node as ProseMirrorNode } from "prosemirror-model";
import { Step } from "prosemirror-transform";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { authComponent } from "./auth";
import { documentSchema } from "./documentSchema";
async function access(ctx: QueryCtx, noteId: Id<"notes">, write = false) {
  const user = await authComponent.getAuthUser(ctx);
  const note = await ctx.db.get(noteId);
  if (
    !note ||
    !(
      note.ownerId === user._id ||
      note.editors.includes(user._id) ||
      (!write && note.readers.includes(user._id))
    )
  )
    throw new ConvexError("Access denied");
  return { user, note };
}
function parse(content: string) {
  if (content.length > 100_000)
    throw new ConvexError("Proof document limit exceeded");
  const doc = documentSchema.nodeFromJSON(JSON.parse(content));
  if (doc.type !== documentSchema.topNodeType)
    throw new ConvexError("Document root required");
  doc.check();
  const ids = new Set<string>();
  doc.forEach((node) => {
    const id = node.attrs.id;
    if (typeof id !== "string" || !id || ids.has(id))
      throw new ConvexError("Invalid paragraph identity");
    ids.add(id);
  });
  return doc;
}
function blocks(doc: ProseMirrorNode) {
  const result = new Map<string, string>();
  doc.forEach((node, _offset, index) =>
    result.set(node.attrs.id, JSON.stringify({ index, node: node.toJSON() })),
  );
  return result;
}
export const create = mutation({
  args: { content: v.string(), editorId: v.optional(v.string()) },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const doc = parse(args.content);
    const content = JSON.stringify(doc.toJSON());
    const id = await ctx.db.insert("notes", {
      ownerId: user._id,
      editors: args.editorId ? [args.editorId] : [],
      readers: [],
      title: doc.firstChild?.textContent || "Untitled",
      content,
      version: 1,
    });
    await ctx.runMutation(components.prosemirrorSync.lib.submitSnapshot, {
      id,
      version: 1,
      content,
      pruneSnapshots: false,
    });
    return id;
  },
});
export const read = query({
  args: { noteId: v.id("notes") },
  returns: v.object({ content: v.string(), version: v.number() }),
  handler: async (ctx, args) => {
    const { note } = await access(ctx, args.noteId);
    return { content: note.content, version: note.version };
  },
});
export const claim = mutation({
  args: { noteId: v.id("notes"), blockId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { user, note } = await access(ctx, args.noteId, true);
    if (!blocks(parse(note.content)).has(args.blockId))
      throw new ConvexError("Missing paragraph");
    const prior = await ctx.db
      .query("claims")
      .withIndex("by_note_block", (q) =>
        q.eq("noteId", args.noteId).eq("blockId", args.blockId),
      )
      .unique();
    if (
      prior &&
      !prior.cancelled &&
      prior.expiresAt > Date.now() &&
      prior.holderId !== user._id
    )
      throw new ConvexError("Already claimed");
    const generation = (prior?.generation ?? 0) + 1;
    const fields = {
      ...args,
      holderId: user._id,
      generation,
      expiresAt: Date.now() + 60_000,
      cancelled: false,
    };
    if (prior) await ctx.db.patch(prior._id, fields);
    else await ctx.db.insert("claims", fields);
    return generation;
  },
});
export const cancel = mutation({
  args: { noteId: v.id("notes"), blockId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await access(ctx, args.noteId, true);
    const prior = await ctx.db
      .query("claims")
      .withIndex("by_note_block", (q) =>
        q.eq("noteId", args.noteId).eq("blockId", args.blockId),
      )
      .unique();
    if (prior)
      await ctx.db.patch(prior._id, {
        cancelled: true,
        generation: prior.generation + 1,
      });
    return null;
  },
});
export const claimStatus = query({
  args: { noteId: v.id("notes"), blockId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      generation: v.number(),
      cancelled: v.boolean(),
      holderId: v.string(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await access(ctx, args.noteId);
    const c = await ctx.db
      .query("claims")
      .withIndex("by_note_block", (q) =>
        q.eq("noteId", args.noteId).eq("blockId", args.blockId),
      )
      .unique();
    return c
      ? {
          generation: c.generation,
          cancelled: c.cancelled,
          holderId: c.holderId,
          expiresAt: c.expiresAt,
        }
      : null;
  },
});
const response = v.union(
  v.object({
    status: v.literal("synced"),
    version: v.number(),
    replayed: v.boolean(),
  }),
  v.object({
    status: v.literal("needs-rebase"),
    version: v.number(),
    steps: v.array(v.string()),
  }),
);
export const submit = mutation({
  args: {
    noteId: v.id("notes"),
    requestId: v.string(),
    version: v.number(),
    steps: v.array(v.string()),
    deviceTime: v.number(),
    claim: v.optional(
      v.object({ blockId: v.string(), generation: v.number() }),
    ),
  },
  returns: response,
  handler: async (ctx, args) => {
    const { user, note } = await access(ctx, args.noteId, true);
    if (
      !args.requestId ||
      args.requestId.length > 128 ||
      args.steps.length < 1 ||
      args.steps.length > 32 ||
      !Number.isFinite(args.deviceTime) ||
      args.steps.some((s) => s.length > 16_000)
    )
      throw new ConvexError("Invalid operation");
    const digest = JSON.stringify({
      version: args.version,
      steps: args.steps,
      deviceTime: args.deviceTime,
      claim: args.claim ?? null,
    });
    const prior = await ctx.db
      .query("receipts")
      .withIndex("by_request", (q) =>
        q
          .eq("noteId", args.noteId)
          .eq("actorId", user._id)
          .eq("requestId", args.requestId),
      )
      .unique();
    if (prior) {
      if (prior.digest !== digest) throw new ConvexError("Request ID reused");
      return {
        status: "synced" as const,
        version: prior.version,
        replayed: true,
      };
    }
    const principal = await ctx.db
      .query("principals")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (principal?.kind === "agent" && !args.claim)
      throw new ConvexError("Agent claim required");
    if (args.claim) {
      const c = await ctx.db
        .query("claims")
        .withIndex("by_note_block", (q) =>
          q.eq("noteId", args.noteId).eq("blockId", args.claim!.blockId),
        )
        .unique();
      if (
        !c ||
        c.cancelled ||
        c.expiresAt <= Date.now() ||
        c.holderId !== user._id ||
        c.generation !== args.claim.generation
      )
        throw new ConvexError("Edit interrupted");
    }
    if (
      !Number.isSafeInteger(args.version) ||
      args.version < 1 ||
      args.version > note.version
    )
      throw new ConvexError("Invalid revision");
    if (args.version !== note.version) {
      const delta = await ctx.runQuery(
        components.prosemirrorSync.lib.getSteps,
        { id: args.noteId, version: args.version },
      );
      return {
        status: "needs-rebase" as const,
        version: delta.version,
        steps: delta.steps,
      };
    }
    const original = parse(note.content);
    let next = original;
    for (const serialized of args.steps) {
      const result = Step.fromJSON(
        documentSchema,
        JSON.parse(serialized),
      ).apply(next);
      if (result.failed || !result.doc) throw new ConvexError("Invalid edit");
      next = result.doc;
    }
    parse(JSON.stringify(next.toJSON()));
    const oldBlocks = blocks(original),
      newBlocks = blocks(next);
    for (const id of new Set([...oldBlocks.keys(), ...newBlocks.keys()])) {
      if (oldBlocks.get(id) === newBlocks.get(id)) continue;
      const c = await ctx.db
        .query("claims")
        .withIndex("by_note_block", (q) =>
          q.eq("noteId", args.noteId).eq("blockId", id),
        )
        .unique();
      if (
        c &&
        !c.cancelled &&
        c.expiresAt > Date.now() &&
        c.holderId !== user._id
      )
        throw new ConvexError("Paragraph claimed");
      if (args.claim && args.claim.blockId !== id)
        throw new ConvexError("Edit exceeds claimed paragraph");
    }
    const result = await ctx.runMutation(
      components.prosemirrorSync.lib.submitSteps,
      {
        id: args.noteId,
        version: args.version,
        clientId: user._id,
        steps: args.steps,
      },
    );
    if (result.status !== "synced")
      throw new ConvexError("Unexpected component revision");
    const version = note.version + args.steps.length,
      content = JSON.stringify(next.toJSON());
    await ctx.runMutation(components.prosemirrorSync.lib.submitSnapshot, {
      id: args.noteId,
      version,
      content,
      pruneSnapshots: false,
    });
    await ctx.db.patch(args.noteId, {
      content,
      version,
      title: next.firstChild?.textContent || "Untitled",
    });
    await ctx.db.insert("receipts", {
      noteId: args.noteId,
      actorId: user._id,
      requestId: args.requestId,
      digest,
      version,
      deviceTime: args.deviceTime,
      acceptedAt: Date.now(),
    });
    return { status: "synced" as const, version, replayed: false };
  },
});
export const history = query({
  args: { noteId: v.id("notes"), before: v.optional(v.number()) },
  returns: v.array(
    v.object({
      version: v.number(),
      actorId: v.string(),
      deviceTime: v.number(),
      acceptedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await access(ctx, args.noteId, true);
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_note_version", (q) =>
        q
          .eq("noteId", args.noteId)
          .lt("version", args.before ?? Number.MAX_SAFE_INTEGER),
      )
      .order("desc")
      .take(20);
    return rows.map(({ version, actorId, deviceTime, acceptedAt }) => ({
      version,
      actorId,
      deviceTime,
      acceptedAt,
    }));
  },
});
export const removeEditor = mutation({
  args: { noteId: v.id("notes"), editorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, note } = await access(ctx, args.noteId, true);
    if (note.ownerId !== user._id) throw new ConvexError("Owner required");
    await ctx.db.patch(args.noteId, {
      editors: note.editors.filter((id) => id !== args.editorId),
    });
    return null;
  },
});

export const addEditor = mutation({
  args: { noteId: v.id("notes"), editorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, note } = await access(ctx, args.noteId, true);
    if (note.ownerId !== user._id) throw new ConvexError("Owner required");
    await ctx.db.patch(args.noteId, {
      editors: [...new Set([...note.editors, args.editorId])],
    });
    return null;
  },
});
export const revision = query({
  args: { noteId: v.id("notes"), version: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    await access(ctx, args.noteId, true);
    const s = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, {
      id: args.noteId,
      version: args.version,
    });
    if (!s.content || s.version !== args.version)
      throw new ConvexError("Revision unavailable");
    return s.content;
  },
});
