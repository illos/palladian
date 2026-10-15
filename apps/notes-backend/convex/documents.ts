import {
  assignBlockIds,
  blockIdProblems,
  deriveSummary,
  DOC_JSON_LIMIT,
  notesSchema,
  parseStoredDoc,
  plainText,
} from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { fail, type Principal } from "./access";

/** Collaboration limits; requests beyond them are rejected, not truncated. */
export const MAX_STEPS_PER_PUSH = 500;
export const MAX_STEP_JSON = 800_000;
export const CHECKPOINT_INTERVAL = 100;
export const STEP_PAGE = 200;
const HISTORY_IDLE_MS = 5 * 60_000;
const SUMMARY_DELAY_MS = 2_000;

type Ctx = QueryCtx | MutationCtx;

export async function nextSeq(ctx: MutationCtx, notebookId: Id<"notebooks">) {
  const counter = await ctx.db
    .query("notebookSequences")
    .withIndex("by_notebook", (q) => q.eq("notebookId", notebookId))
    .unique();
  if (!counter) {
    await ctx.db.insert("notebookSequences", { notebookId, seq: 1 });
    return 1;
  }
  await ctx.db.patch(counter._id, { seq: counter.seq + 1 });
  return counter.seq + 1;
}

export async function getContent(ctx: Ctx, noteId: Id<"notes">) {
  const content = await ctx.db
    .query("noteContent")
    .withIndex("by_note", (q) => q.eq("noteId", noteId))
    .unique();
  if (!content) fail("not_found", "Note content is missing.");
  return content;
}

export function parseSteps(json: string[]): Step[] {
  if (json.length < 1 || json.length > MAX_STEPS_PER_PUSH)
    fail("invalid", `Submit between 1 and ${MAX_STEPS_PER_PUSH} steps.`);
  return json.map((value) => {
    if (value.length > MAX_STEP_JSON) fail("too_large", "Step is too large.");
    try {
      return Step.fromJSON(notesSchema, JSON.parse(value));
    } catch {
      fail("invalid", "A submitted step is malformed.");
    }
  });
}

export function serializeDoc(doc: ProseMirrorNode) {
  const json = JSON.stringify(doc.toJSON());
  if (json.length > DOC_JSON_LIMIT)
    fail("too_large", "The note would exceed the supported size.");
  return json;
}

/** Validate and normalize a document submitted for creation. */
export function normalizeNewDoc(json: string): ProseMirrorNode {
  let doc: ProseMirrorNode;
  try {
    doc = parseStoredDoc(json);
  } catch {
    fail("invalid", "The note document is not valid.");
  }
  return blockIdProblems(doc) ? assignBlockIds(new Transform(doc)).doc : doc;
}

export async function createNoteRecord(
  ctx: MutationCtx,
  args: {
    notebook: Doc<"notebooks">;
    actor: Principal;
    doc: ProseMirrorNode;
    clientKey?: string;
    deviceTime?: number;
  },
) {
  const now = Date.now();
  const json = serializeDoc(args.doc);
  const { title, preview } = deriveSummary(args.doc);
  const noteId = await ctx.db.insert("notes", {
    notebookId: args.notebook._id,
    // Notes belong to the notebook owner, whoever created them.
    ownerId: args.notebook.ownerId,
    creatorId: args.actor._id,
    title,
    preview,
    createdAt: now,
    editedAt: now,
    lifecycle: "active",
    restricted: false,
    seq: await nextSeq(ctx, args.notebook._id),
    ...(args.clientKey ? { clientKey: args.clientKey } : {}),
  });
  await ctx.db.insert("noteContent", {
    noteId,
    doc: json,
    revision: 0,
    updatedAt: now,
    summaryDue: false,
  });
  await ctx.db.insert("noteText", {
    noteId,
    notebookId: args.notebook._id,
    trashed: false,
    text: plainText(args.doc),
  });
  await ctx.db.insert("noteCheckpoints", { noteId, revision: 0, doc: json });
  await ctx.db.insert("noteVersions", {
    noteId,
    baseRevision: 0,
    revision: 0,
    actorId: args.actor._id,
    actorKind: args.actor.kind,
    kind: "create",
    startedAt: now,
    endedAt: now,
    ...(args.deviceTime !== undefined ? { deviceTime: args.deviceTime } : {}),
  });
  return noteId;
}

/**
 * Append accepted steps at the current revision. Callers have already checked
 * edit access and that the steps were made against this revision.
 */
export async function commitSteps(
  ctx: MutationCtx,
  args: {
    note: Doc<"notes">;
    content: Doc<"noteContent">;
    actor: Principal;
    steps: Step[];
    clientId: string;
    kind: "edit" | "restore";
    deviceTime?: number;
  },
): Promise<{ revision: number; doc: ProseMirrorNode }> {
  if (args.note.lifecycle !== "active")
    fail("trashed", "Restore this note from Trash before editing it.");
  let doc = parseStoredDoc(args.content.doc);
  for (const step of args.steps) {
    const result = step.apply(doc);
    if (!result.doc)
      fail("invalid", result.failed ?? "A step could not be applied.");
    doc = result.doc;
  }
  // Repair IDs after concurrent splits or pastes; clients receive the fix as steps.
  const repairs = blockIdProblems(doc)
    ? assignBlockIds(new Transform(doc)).steps
    : [];
  for (const step of repairs) doc = step.apply(doc).doc!;
  try {
    doc.check();
  } catch {
    fail("invalid", "The edit would produce an invalid note.");
  }
  const json = serializeDoc(doc);

  const now = Date.now();
  let revision = args.content.revision;
  for (const step of args.steps)
    await ctx.db.insert("noteSteps", {
      noteId: args.note._id,
      revision: ++revision,
      step: JSON.stringify(step.toJSON()),
      clientId: args.clientId,
      actorId: args.actor._id,
    });
  for (const step of repairs)
    await ctx.db.insert("noteSteps", {
      noteId: args.note._id,
      revision: ++revision,
      step: JSON.stringify(step.toJSON()),
      clientId: "server",
      actorId: args.actor._id,
    });
  if (
    Math.floor(revision / CHECKPOINT_INTERVAL) >
    Math.floor(args.content.revision / CHECKPOINT_INTERVAL)
  )
    await ctx.db.insert("noteCheckpoints", {
      noteId: args.note._id,
      revision,
      doc: json,
    });
  await ctx.db.patch(args.content._id, {
    doc: json,
    revision,
    updatedAt: now,
    summaryDue: true,
  });
  if (!args.content.summaryDue)
    await ctx.scheduler.runAfter(
      SUMMARY_DELAY_MS,
      internal.notes.refreshSummary,
      { noteId: args.note._id },
    );

  const last = await ctx.db
    .query("noteVersions")
    .withIndex("by_note_and_revision", (q) => q.eq("noteId", args.note._id))
    .order("desc")
    .first();
  if (
    last &&
    args.kind === "edit" &&
    last.kind === "edit" &&
    last.actorId === args.actor._id &&
    now - last.endedAt < HISTORY_IDLE_MS
  )
    await ctx.db.patch(last._id, { revision, endedAt: now });
  else
    await ctx.db.insert("noteVersions", {
      noteId: args.note._id,
      baseRevision: args.content.revision,
      revision,
      actorId: args.actor._id,
      actorKind: args.actor.kind,
      kind: args.kind,
      startedAt: now,
      endedAt: now,
      ...(args.deviceTime !== undefined ? { deviceTime: args.deviceTime } : {}),
    });
  return { revision, doc };
}

/** Rebuild the document at any revision from a checkpoint and the step log. */
export async function docAtRevision(
  ctx: Ctx,
  noteId: Id<"notes">,
  revision: number,
): Promise<ProseMirrorNode> {
  const checkpoint = await ctx.db
    .query("noteCheckpoints")
    .withIndex("by_note_and_revision", (q) =>
      q.eq("noteId", noteId).lte("revision", revision),
    )
    .order("desc")
    .first();
  if (!checkpoint) fail("not_found", "That revision is not available.");
  let doc = parseStoredDoc(checkpoint.doc);
  const steps = await ctx.db
    .query("noteSteps")
    .withIndex("by_note_and_revision", (q) =>
      q
        .eq("noteId", noteId)
        .gt("revision", checkpoint.revision)
        .lte("revision", revision),
    )
    .take(CHECKPOINT_INTERVAL + MAX_STEPS_PER_PUSH + 10);
  for (const row of steps) {
    const result = Step.fromJSON(notesSchema, JSON.parse(row.step)).apply(doc);
    if (!result.doc) fail("invalid", "History could not be reconstructed.");
    doc = result.doc;
  }
  return doc;
}

/** Recompute list, preview and search projections from the accepted document. */
export async function refreshProjections(
  ctx: MutationCtx,
  note: Doc<"notes">,
  content: Doc<"noteContent">,
) {
  const doc = parseStoredDoc(content.doc);
  const { title, preview } = deriveSummary(doc);
  await ctx.db.patch(note._id, {
    title,
    preview,
    editedAt: content.updatedAt,
    seq: await nextSeq(ctx, note.notebookId),
  });
  const text = await ctx.db
    .query("noteText")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .unique();
  if (text) await ctx.db.patch(text._id, { text: plainText(doc) });
  await ctx.db.patch(content._id, { summaryDue: false });
}

/** Bump a note in its notebook feed after metadata or access changes. */
export async function touchNote(ctx: MutationCtx, note: Doc<"notes">) {
  await ctx.db.patch(note._id, { seq: await nextSeq(ctx, note.notebookId) });
}

export async function receiptFor(
  ctx: Ctx,
  actor: Principal,
  requestId: string | undefined,
  digest: string,
) {
  if (!requestId) return null;
  if (requestId.length > 128) fail("invalid", "request_id is too long.");
  const prior = await ctx.db
    .query("receipts")
    .withIndex("by_actor_and_request", (q) =>
      q.eq("actorId", actor._id).eq("requestId", requestId),
    )
    .unique();
  if (prior && prior.digest !== digest)
    fail(
      "conflict",
      "This request_id was already used for a different request.",
    );
  return prior;
}

export async function digestOf(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
