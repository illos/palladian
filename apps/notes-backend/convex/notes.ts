import {
  applyEdits,
  deriveSummary,
  docToMarkdown,
  EditError,
  markdownToDoc,
  MarkdownLimitError,
  outline,
  parseStoredDoc,
  type NoteEdit,
} from "@palladian/notes-core";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  accessibleNotebooks,
  atLeast,
  fail,
  getPrincipal,
  loadNote,
  loadNotebook,
  notebookRole,
  noteRole,
  requirePrincipal,
  type Principal,
} from "./access";
import {
  commitSteps,
  createNoteRecord,
  digestOf,
  getContent,
  normalizeNewDoc,
  parseSteps,
  receiptFor,
  refreshProjections,
  STEP_PAGE,
  touchNote,
} from "./documents";
import { MAX_SOURCE_NOTES, scheduleNoteSync } from "./references";
import { accessRole, noteEdit, noteSummary, toSummary } from "./validators";

/**
 * Pick the destination notebook, requiring edit access.
 *
 * A person's note for a notebook that no longer exists or no longer takes
 * their notes (deleted, membership removed, or read-only now) goes where a
 * note without a notebook goes: their default notebook. Work typed against a
 * notebook that went away meanwhile, on this device or offline on another,
 * is therefore kept rather than refused (plan 08 A5, review round 1; a
 * recovery-placement decision for review, Q11). Agents are refused as before.
 */
async function destination(
  ctx: MutationCtx,
  actor: Principal,
  notebookId: Id<"notebooks"> | undefined,
): Promise<Doc<"notebooks">> {
  if (notebookId && actor.kind !== "human")
    return (await loadNotebook(ctx, actor, notebookId, "edit")).notebook;
  if (notebookId) {
    const named = await ctx.db.get(notebookId);
    if (named && atLeast(await notebookRole(ctx, actor, named), "edit"))
      return named;
  }
  if (actor.kind === "human" && actor.defaultNotebookId) {
    const notebook = await ctx.db.get(actor.defaultNotebookId);
    if (notebook && atLeast(await notebookRole(ctx, actor, notebook), "edit"))
      return notebook;
  }
  const editable = (await accessibleNotebooks(ctx, actor)).filter((entry) =>
    atLeast(entry.role, "edit"),
  );
  if (editable.length === 1) return editable[0]!.notebook;
  if (actor.controllerId) {
    const controller = await ctx.db.get(actor.controllerId);
    const preferred = editable.find(
      (entry) => entry.notebook._id === controller?.defaultNotebookId,
    );
    if (preferred) return preferred.notebook;
  }
  if (!editable.length)
    fail("denied", "No notebook is shared with edit access.");
  fail(
    "invalid",
    "Choose a notebook: " + editable.map((e) => e.notebook.name).join(", "),
  );
}

/** Source notes are hints checked exactly in references.ts; bound them. */
function checkSources(sourceNoteIds: Id<"notes">[]) {
  if (sourceNoteIds.length > MAX_SOURCE_NOTES)
    fail("invalid", `Name at most ${MAX_SOURCE_NOTES} source notes.`);
  return sourceNoteIds;
}

function editFailure(error: unknown): never {
  if (error instanceof EditError)
    fail(
      error.code === "ambiguous" || error.code === "not_found"
        ? "invalid"
        : error.code === "conflict"
          ? "conflict"
          : "invalid",
      `Edit ${error.editIndex + 1}: ${error.message}`,
    );
  if (error instanceof MarkdownLimitError) fail("too_large", error.message);
  throw error;
}

export const create = mutation({
  args: {
    notebookId: v.optional(v.id("notebooks")),
    clientKey: v.string(),
    doc: v.string(),
    deviceTime: v.optional(v.number()),
    /** A conflict copy names the note whose content it holds. */
    sourceNoteId: v.optional(v.id("notes")),
    /**
     * The account the app made the copy in (the Better Auth user ID), as in
     * arrangement.ts. A creation that reaches the server under another
     * sign-in, e.g. one queued before the person switched accounts, is
     * refused. Only an equality check against the caller; it grants nothing.
     * Optional: drafts and older clients do not send it.
     */
    account: v.optional(v.string()),
  },
  returns: v.object({
    noteId: v.id("notes"),
    revision: v.number(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    // Before the replay lookup, so another account never gets a copy back.
    if (args.account !== undefined && actor.authUserId !== args.account)
      fail("conflict", "This change was made in another account.");
    if (!args.clientKey || args.clientKey.length > 64)
      fail("invalid", "Invalid client key.");
    // A retried creation returns the note it already created, if the caller can
    // still open it. The original document stands; later content must be sent
    // as edits, so callers compare before treating local work as saved.
    const existing = await ctx.db
      .query("notes")
      .withIndex("by_creator_and_client_key", (q) =>
        q.eq("creatorId", actor._id).eq("clientKey", args.clientKey),
      )
      .unique();
    if (existing) {
      if (!(await noteRole(ctx, actor, existing)))
        fail("not_found", "Note not found.");
      const content = await getContent(ctx, existing._id);
      return {
        noteId: existing._id,
        revision: content.revision,
        replayed: true,
      };
    }
    // A copy of another note's content needs access to that note now.
    if (args.sourceNoteId) {
      const source = await ctx.db.get(args.sourceNoteId);
      if (!source || !(await noteRole(ctx, actor, source)))
        fail("not_found", "Note not found.");
    }
    const notebook = await destination(ctx, actor, args.notebookId);
    const noteId = await createNoteRecord(ctx, {
      notebook,
      actor,
      doc: normalizeNewDoc(args.doc),
      clientKey: args.clientKey,
      ...(args.deviceTime !== undefined ? { deviceTime: args.deviceTime } : {}),
      // Attachments in a copy are usable through the note it copies.
      ...(args.sourceNoteId ? { sources: [args.sourceNoteId] } : {}),
    });
    return { noteId, revision: 0, replayed: false };
  },
});

export const createFromMarkdown = mutation({
  args: {
    notebookId: v.optional(v.id("notebooks")),
    markdown: v.string(),
    requestId: v.optional(v.string()),
    /** Notes attachments in the Markdown came from; proves access to them. */
    sourceNoteIds: v.optional(v.array(v.id("notes"))),
  },
  returns: v.object({
    noteId: v.id("notes"),
    notebookId: v.id("notebooks"),
    title: v.string(),
    revision: v.number(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const digest = await digestOf([
      "create",
      args.notebookId ?? null,
      args.markdown,
    ]);
    const prior = await receiptFor(ctx, actor, args.requestId, digest);
    if (prior) {
      const note = await ctx.db.get(prior.noteId);
      // Replays reveal nothing the caller can no longer open.
      if (!note || !(await noteRole(ctx, actor, note)))
        fail("not_found", "The note created by this request is not available.");
      return {
        noteId: note._id,
        notebookId: note.notebookId,
        title: note.title,
        revision: prior.revision,
        replayed: true,
      };
    }
    const notebook = await destination(ctx, actor, args.notebookId);
    let doc;
    try {
      doc = markdownToDoc(args.markdown);
    } catch (error) {
      editFailure(error);
    }
    const noteId = await createNoteRecord(ctx, {
      notebook,
      actor,
      doc,
      ...(args.sourceNoteIds
        ? { sources: checkSources(args.sourceNoteIds) }
        : {}),
    });
    if (args.requestId)
      await ctx.db.insert("receipts", {
        actorId: actor._id,
        requestId: args.requestId,
        digest,
        noteId,
        revision: 0,
        createdAt: Date.now(),
      });
    const note = (await ctx.db.get(noteId))!;
    return {
      noteId,
      notebookId: notebook._id,
      title: note.title,
      revision: 0,
      replayed: false,
    };
  },
});

export const get = query({
  args: { noteId: v.id("notes") },
  returns: v.union(
    v.null(),
    v.object({
      summary: noteSummary,
      notebook: v.union(
        v.null(),
        v.object({ id: v.id("notebooks"), name: v.string() }),
      ),
      ownerId: v.id("principals"),
      creatorId: v.id("principals"),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const note = await ctx.db.get(args.noteId);
    if (!note) return null;
    const role = await noteRole(ctx, principal, note);
    if (!role) return null;
    const notebook = await ctx.db.get(note.notebookId);
    const visible =
      notebook && (await notebookRole(ctx, principal, notebook)) !== null;
    return {
      summary: toSummary(note, role),
      notebook: visible ? { id: notebook._id, name: notebook.name } : null,
      ownerId: note.ownerId,
      creatorId: note.creatorId,
    };
  },
});

/**
 * Access to one note as decided when this call runs. A mutation always reaches
 * the server, unlike a query a local subscription can answer, so a client may
 * lift a revocation fence on its result.
 */
export const verifyAccess = mutation({
  args: { noteId: v.id("notes") },
  returns: v.object({
    subject: v.union(v.string(), v.null()),
    summary: v.union(v.null(), noteSummary),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const principal = await getPrincipal(ctx);
    if (!identity || !principal) return { subject: null, summary: null };
    const note = await ctx.db.get(args.noteId);
    const role = note ? await noteRole(ctx, principal, note) : null;
    return {
      subject: identity.subject,
      summary: note && role ? toSummary(note, role) : null,
    };
  },
});

/** Current accepted document. Readers use this; editors start from it. */
export const content = query({
  args: { noteId: v.id("notes") },
  returns: v.union(
    v.null(),
    v.object({ doc: v.string(), revision: v.number(), role: accessRole }),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const note = await ctx.db.get(args.noteId);
    if (!note) return null;
    const role = await noteRole(ctx, principal, note);
    if (!role) return null;
    const content = await getContent(ctx, note._id);
    return { doc: content.doc, revision: content.revision, role };
  },
});

/** Steps after a revision, for collaborative editors. Requires edit access. */
export const steps = query({
  args: { noteId: v.id("notes"), after: v.number() },
  returns: v.object({
    steps: v.array(v.object({ step: v.string(), clientId: v.string() })),
    from: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.after) || args.after < 0)
      fail("invalid", "Invalid revision.");
    const principal = await requirePrincipal(ctx);
    await loadNote(ctx, principal, args.noteId, "edit");
    const rows = await ctx.db
      .query("noteSteps")
      .withIndex("by_note_and_revision", (q) =>
        q.eq("noteId", args.noteId).gt("revision", args.after),
      )
      .take(STEP_PAGE);
    return {
      steps: rows.map((row) => ({ step: row.step, clientId: row.clientId })),
      from: args.after,
      more: rows.length === STEP_PAGE,
    };
  },
});

/** Submit editor steps made against `revision`. Behind clients rebase and retry. */
export const push = mutation({
  args: {
    noteId: v.id("notes"),
    revision: v.number(),
    steps: v.array(v.string()),
    clientId: v.string(),
    deviceTime: v.optional(v.number()),
    /** Notes pasted attachments came from; proves access to them at once. */
    sourceNoteIds: v.optional(v.array(v.id("notes"))),
  },
  returns: v.union(
    v.object({ status: v.literal("accepted"), revision: v.number() }),
    v.object({ status: v.literal("behind"), revision: v.number() }),
  ),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    if (
      !args.clientId ||
      args.clientId.length > 64 ||
      args.clientId === "server"
    )
      fail("invalid", "Invalid client id.");
    const { note } = await loadNote(ctx, actor, args.noteId, "edit");
    const content = await getContent(ctx, note._id);
    if (args.revision !== content.revision)
      return { status: "behind" as const, revision: content.revision };
    const result = await commitSteps(ctx, {
      note,
      content,
      actor,
      steps: parseSteps(args.steps),
      clientId: args.clientId,
      kind: "edit",
      ...(args.deviceTime !== undefined ? { deviceTime: args.deviceTime } : {}),
      ...(args.sourceNoteIds
        ? { sources: checkSources(args.sourceNoteIds) }
        : {}),
    });
    return { status: "accepted" as const, revision: result.revision };
  },
});

const MAX_READ_CHARS = 200_000;

export const readMarkdown = query({
  args: {
    noteId: v.id("notes"),
    format: v.union(v.literal("markdown"), v.literal("outline")),
    offset: v.optional(v.number()),
    maxChars: v.optional(v.number()),
  },
  returns: v.object({
    summary: noteSummary,
    notebookName: v.union(v.string(), v.null()),
    revision: v.number(),
    markdown: v.union(v.string(), v.null()),
    outline: v.union(
      v.null(),
      v.array(
        v.object({
          id: v.string(),
          type: v.string(),
          depth: v.number(),
          parentId: v.union(v.string(), v.null()),
          hash: v.string(),
          markdown: v.string(),
          checked: v.optional(v.boolean()),
        }),
      ),
    ),
    totalChars: v.number(),
    nextOffset: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    const { note, role } = await loadNote(ctx, principal, args.noteId, "read");
    const content = await getContent(ctx, note._id);
    const doc = parseStoredDoc(content.doc);
    const notebook = await ctx.db.get(note.notebookId);
    const notebookName =
      notebook && (await notebookRole(ctx, principal, notebook)) !== null
        ? notebook.name
        : null;
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit = Math.min(
      MAX_READ_CHARS,
      Math.max(1000, Math.floor(args.maxChars ?? 60_000)),
    );
    if (args.format === "outline") {
      const entries = outline(doc);
      let used = 0;
      const page = [];
      for (const entry of entries.slice(offset)) {
        if (used + entry.markdown.length > limit && page.length) break;
        used += entry.markdown.length;
        page.push(entry);
      }
      const next = offset + page.length;
      return {
        summary: toSummary(note, role),
        notebookName,
        revision: content.revision,
        markdown: null,
        outline: page,
        totalChars: entries.reduce((n, e) => n + e.markdown.length, 0),
        nextOffset: next < entries.length ? next : null,
      };
    }
    const markdown = docToMarkdown(doc);
    const slice = markdown.slice(offset, offset + limit);
    const next = offset + slice.length;
    return {
      summary: toSummary(note, role),
      notebookName,
      revision: content.revision,
      markdown: slice,
      outline: null,
      totalChars: markdown.length,
      nextOffset: next < markdown.length ? next : null,
    };
  },
});

/** Bounded atomic Markdown-level edits, converted to steps at the current revision. */
export const edit = mutation({
  args: {
    noteId: v.id("notes"),
    edits: v.array(noteEdit),
    expectedRevision: v.optional(v.number()),
    requestId: v.optional(v.string()),
    /** Notes attachments in the new Markdown came from. */
    sourceNoteIds: v.optional(v.array(v.id("notes"))),
  },
  returns: v.object({
    revision: v.number(),
    previousRevision: v.number(),
    title: v.string(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "edit");
    const digest = await digestOf([
      "edit",
      args.noteId,
      args.edits,
      args.expectedRevision ?? null,
    ]);
    const prior = await receiptFor(ctx, actor, args.requestId, digest);
    if (prior)
      return {
        revision: prior.revision,
        previousRevision: prior.revision,
        title: note.title,
        replayed: true,
      };
    if (
      args.expectedRevision === undefined &&
      args.edits.some((edit) => edit.type === "replace_all")
    )
      fail("invalid", "Replacing the whole note requires expected_revision.");
    const content = await getContent(ctx, note._id);
    if (
      args.expectedRevision !== undefined &&
      args.expectedRevision !== content.revision
    ) {
      // Text matches and block hashes verify content; anything else needs the exact revision.
      const unverified = args.edits.some(
        (edit) =>
          edit.type === "replace_all" ||
          ((edit.type === "replace_block" || edit.type === "delete_block") &&
            edit.block_hash === undefined),
      );
      if (unverified)
        fail(
          "conflict",
          `The note changed (revision ${content.revision}, expected ${args.expectedRevision}). Read it again.`,
        );
    }
    let tr;
    try {
      tr = applyEdits(parseStoredDoc(content.doc), args.edits as NoteEdit[]);
    } catch (error) {
      editFailure(error);
    }
    if (!tr.steps.length)
      return {
        revision: content.revision,
        previousRevision: content.revision,
        title: note.title,
        replayed: false,
      };
    const result = await commitSteps(ctx, {
      note,
      content,
      actor,
      steps: tr.steps,
      clientId: "agent:" + actor._id,
      kind: "edit",
      ...(args.sourceNoteIds
        ? { sources: checkSources(args.sourceNoteIds) }
        : {}),
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
    return {
      revision: result.revision,
      previousRevision: content.revision,
      title: deriveSummary(result.doc).title,
      replayed: false,
    };
  },
});

async function setLifecycle(
  ctx: MutationCtx,
  noteId: Id<"notes">,
  trashed: boolean,
) {
  const actor = await requirePrincipal(ctx);
  const { note } = await loadNote(ctx, actor, noteId, "edit");
  await changeLifecycle(ctx, note, trashed);
  return null;
}

/**
 * Move a note to Trash or back: its lifecycle, search projection and feed
 * entry. Callers have checked edit access.
 */
export async function changeLifecycle(
  ctx: MutationCtx,
  note: Doc<"notes">,
  trashed: boolean,
) {
  if ((note.lifecycle === "trashed") === trashed) return;
  await ctx.db.patch(note._id, {
    lifecycle: trashed ? "trashed" : "active",
    ...(trashed ? { trashedAt: Date.now() } : { trashedAt: undefined }),
  });
  const text = await ctx.db
    .query("noteText")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .unique();
  if (text) await ctx.db.patch(text._id, { trashed });
  await touchNote(ctx, (await ctx.db.get(note._id))!);
  // Objects only this note uses follow it into and out of Trash (D42).
  await scheduleNoteSync(ctx, note._id);
}

export const trash = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: (ctx, args) => setLifecycle(ctx, args.noteId, true),
});

export const restore = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: (ctx, args) => setLifecycle(ctx, args.noteId, false),
});

export const refreshSummary = internalMutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) return null;
    const content = await ctx.db
      .query("noteContent")
      .withIndex("by_note", (q) => q.eq("noteId", note._id))
      .unique();
    if (!content?.summaryDue) return null;
    await refreshProjections(ctx, note, content);
    return null;
  },
});
