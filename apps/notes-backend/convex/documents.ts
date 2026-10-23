import {
  applySafeStep,
  assertSafeDocument,
  attachmentIds,
  assignBlockIds,
  blockIdProblems,
  deriveSummary,
  DOC_JSON_LIMIT,
  notesSchema,
  parseStoredDoc,
  parseSubmittedDoc,
  plainText,
  stepAttachmentIds,
  UnsafeDocumentError,
} from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { fail, type Principal } from "./access";
import { MAX_NOTE_OBJECTS, recordReferences } from "./references";

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
    doc = parseSubmittedDoc(json);
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
    /** Notes its attachments were copied from, to prove access to them. */
    sources?: Id<"notes">[];
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
  await recordReferences(ctx, {
    note: { _id: noteId, lifecycle: "active" },
    actor: args.actor,
    before: null,
    after: args.doc,
    ...(args.sources ? { sources: args.sources } : {}),
  });
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
    /** Notes new attachments were copied from, to prove access to them. */
    sources?: Id<"notes">[];
    /**
     * The steps restore content the server rebuilt from this note's own
     * history (history.restore), which may hold image sources from before
     * attachments. Never set for steps a client submits.
     */
    historical?: boolean;
  },
): Promise<{ revision: number; doc: ProseMirrorNode }> {
  if (args.note.lifecycle !== "active")
    fail("trashed", "Restore this note from Trash before editing it.");
  const before = parseStoredDoc(args.content.doc);
  let doc = before;
  let revision = args.content.revision;
  // Objects any accepted revision of this batch references (each step is a
  // revision), so history references are recorded too.
  const seen = new Set<string>();
  // Every accepted revision must stay within the attachment limit, so any of
  // them can be restored. The union bounds each revision's count; only when
  // it passes the limit is a revision counted exactly.
  const union = new Set(attachmentIds(before));
  const baseline = union.size;
  // Checkpoints land on every interval boundary, even inside a large batch, so
  // any revision is rebuilt from at most one interval of steps.
  const checkpoints: { revision: number; doc: ProseMirrorNode }[] = [];
  // Each step is validated for what it introduces, so every revision in the
  // batch, including persisted checkpoints, stays within the safety contract.
  const apply = (step: Step, historical = false) => {
    let added: string[] = [];
    try {
      doc = applySafeStep(doc, step, { legacySources: historical });
      added = stepAttachmentIds(step);
    } catch (error) {
      fail(
        "invalid",
        error instanceof UnsafeDocumentError
          ? "The edit would produce an invalid or unsafe note."
          : error instanceof Error
            ? error.message
            : "A step could not be applied.",
      );
    }
    for (const objectId of added) {
      seen.add(objectId);
      union.add(objectId);
    }
    if (added.length && union.size > MAX_NOTE_OBJECTS) {
      const count = attachmentIds(doc).length;
      if (count > MAX_NOTE_OBJECTS && count > baseline)
        fail(
          "too_large",
          `A note can contain at most ${MAX_NOTE_OBJECTS} attachments, in every revision.`,
        );
    }
    if (++revision % CHECKPOINT_INTERVAL === 0) {
      // A checkpoint is read back with parseStoredDoc; hold it to the same bar.
      try {
        doc.check();
        assertSafeDocument(doc, { legacySources: true });
      } catch {
        fail("invalid", "The edit would produce an invalid or unsafe note.");
      }
      checkpoints.push({ revision, doc });
    }
  };
  for (const step of args.steps) apply(step, !!args.historical);
  // Repair IDs after concurrent splits or pastes; clients receive the fix as steps.
  const repairs = blockIdProblems(doc)
    ? assignBlockIds(new Transform(doc)).steps
    : [];
  for (const step of repairs) apply(step);
  // New content was checked strictly step by step; stored blocks may keep
  // image sources from before attachments.
  try {
    doc.check();
    assertSafeDocument(doc, { legacySources: true });
  } catch {
    fail("invalid", "The edit would produce an invalid or unsafe note.");
  }
  const json = serializeDoc(doc);
  // Which objects the accepted revisions reference (B1); may refuse an edit
  // that exceeds the attachment limits, before anything is written.
  await recordReferences(ctx, {
    note: args.note,
    actor: args.actor,
    before,
    after: doc,
    seen,
    ...(args.sources ? { sources: args.sources } : {}),
  });

  const now = Date.now();
  let stepRevision = args.content.revision;
  for (const step of args.steps)
    await ctx.db.insert("noteSteps", {
      noteId: args.note._id,
      revision: ++stepRevision,
      step: JSON.stringify(step.toJSON()),
      clientId: args.clientId,
      actorId: args.actor._id,
    });
  for (const step of repairs)
    await ctx.db.insert("noteSteps", {
      noteId: args.note._id,
      revision: ++stepRevision,
      step: JSON.stringify(step.toJSON()),
      clientId: "server",
      actorId: args.actor._id,
    });
  for (const checkpoint of checkpoints)
    await ctx.db.insert("noteCheckpoints", {
      noteId: args.note._id,
      revision: checkpoint.revision,
      doc:
        checkpoint.revision === revision ? json : serializeDoc(checkpoint.doc),
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
  let at = checkpoint.revision;
  // Replay to exactly the requested revision, insisting on a continuous log.
  while (at < revision) {
    const page = await ctx.db
      .query("noteSteps")
      .withIndex("by_note_and_revision", (q) =>
        q.eq("noteId", noteId).gt("revision", at).lte("revision", revision),
      )
      .take(STEP_PAGE);
    if (!page.length)
      fail("invalid", "History is incomplete for that revision.");
    for (const row of page) {
      if (row.revision !== at + 1)
        fail("invalid", "History is incomplete for that revision.");
      const result = Step.fromJSON(notesSchema, JSON.parse(row.step)).apply(
        doc,
      );
      if (!result.doc) fail("invalid", "History could not be reconstructed.");
      doc = result.doc;
      at = row.revision;
    }
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
