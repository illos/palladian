import { attachmentIds } from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { atLeast, fail, noteRole, type Principal, type Role } from "./access";

/**
 * Object references (B1, D36–D42). Every accepted revision records which
 * objects it references, in the same transaction, so access checks and the
 * object lifecycle never disagree with the note:
 *
 * - A reference grants access: a caller who can read a note can read the
 *   objects its current document references; editors (who may read history)
 *   also those any earlier revision referenced.
 * - So a new reference is recorded only when the actor may already use the
 *   object: they uploaded it, this note referenced it before (undo, history
 *   restore), or they can read it through another note. A commit may name
 *   the notes its new attachments came from (`sources`), which is checked
 *   exactly; otherwise a bounded search looks for such a note. When that
 *   search cannot finish within the transaction, the reference is checked
 *   afterwards (files.verifyReference) instead of being refused. A reference
 *   the actor may not use stays in the document but grants nothing and shows
 *   as unavailable, like one to a permanently deleted object.
 * - An object with no live reference (current, in an active note) is in
 *   Trash from that moment; one that gains a live reference leaves Trash.
 *   Neither resets an existing Trash deadline.
 *
 * Reads per commit stay well inside Convex's limits (4,096 index ranges and
 * gets together): at most MAX_NOTE_OBJECTS new and MAX_NOTE_OBJECTS removed
 * objects; per new object about nine reads (the object, this note's row, one
 * per source, two search ranges while the search budget lasts, its live
 * references, a pending check); per removed object three; and at most
 * SEARCH_BUDGET + MAX_SOURCE_NOTES notes' roles, three reads each, memoized.
 */

/** Distinct objects one note may reference at a time, and new ones per change. */
export const MAX_NOTE_OBJECTS = 200;
/** Notes one change may name as where its new attachments came from. */
export const MAX_SOURCE_NOTES = 3;
/** Reference rows a change examines, in total, searching for access. */
export const SEARCH_BUDGET = 48;
/** Reference rows one search step examines for one object. */
const SEARCH_STEP = 8;
/** Rows handled by one scheduled cleanup or verification step. */
export const REF_BATCH = 200;

type Ctx = QueryCtx | MutationCtx;

/** The R2 key of an object's bytes. */
export function objectKey(objectId: Id<"objects">): string {
  return `objects/${objectId}`;
}

export async function refFor(
  ctx: Ctx,
  noteId: Id<"notes">,
  objectId: Id<"objects">,
) {
  return await ctx.db
    .query("objectRefs")
    .withIndex("by_note_and_object", (q) =>
      q.eq("noteId", noteId).eq("objectId", objectId),
    )
    .unique();
}

/** One principal's note roles, looked up once per note within a transaction. */
export class NoteRoles {
  private readonly roles = new Map<Id<"notes">, Role | null>();
  constructor(
    private readonly ctx: Ctx,
    private readonly principal: Principal,
  ) {}
  async of(noteId: Id<"notes">): Promise<Role | null> {
    if (!this.roles.has(noteId)) {
      const note = await this.ctx.db.get(noteId);
      this.roles.set(
        noteId,
        note ? await noteRole(this.ctx, this.principal, note) : null,
      );
    }
    return this.roles.get(noteId)!;
  }
  /** Whether a reference row lets the principal see the object. */
  async grants(ref: Doc<"objectRefs">): Promise<boolean> {
    const role = await this.of(ref.noteId);
    return ref.current ? role !== null : atLeast(role, "edit");
  }
}

/** Put an object in or out of Trash to match its live references. */
export async function settleObject(ctx: MutationCtx, object: Doc<"objects">) {
  const live = await ctx.db
    .query("objectRefs")
    .withIndex("by_object_and_live", (q) =>
      q.eq("objectId", object._id).eq("live", true),
    )
    .first();
  if (live && object.trashedAt !== undefined)
    await ctx.db.patch(object._id, { trashedAt: undefined });
  else if (!live && object.trashedAt === undefined)
    await ctx.db.patch(object._id, { trashedAt: Date.now() });
}

type Decision = "yes" | "no" | "unknown";

/**
 * Whether the actor may use `object` in `noteId`: uploader, a named source
 * note that references it, or the bounded search. "unknown" when the search
 * ran out before finding or excluding access.
 */
async function mayUse(
  ctx: MutationCtx,
  roles: NoteRoles,
  actor: Principal,
  object: Doc<"objects">,
  noteId: Id<"notes">,
  sources: Id<"notes">[],
  budget: { rows: number },
): Promise<Decision> {
  if (object.uploaderId === actor._id) return "yes";
  for (const source of sources) {
    if (source === noteId || !(await roles.of(source))) continue;
    const ref = await refFor(ctx, source, object._id);
    if (ref && (await roles.grants(ref))) return "yes";
  }
  for (const current of [true, false]) {
    if (budget.rows <= 0) return "unknown";
    const take = Math.min(SEARCH_STEP, budget.rows);
    const rows = await ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) =>
        q.eq("objectId", object._id).eq("current", current),
      )
      .take(take + 1);
    for (const ref of rows.slice(0, take)) {
      budget.rows--;
      if (ref.noteId !== noteId && (await roles.grants(ref))) return "yes";
    }
    if (rows.length > take) return "unknown";
  }
  return "no";
}

/**
 * Record the objects a note's newly accepted revisions reference. `before`
 * is the previous accepted document (null for a new note), `after` the new
 * one, and `seen` every object any intermediate revision referenced (from
 * `stepAttachmentIds`). Objects in `after` are current references; objects
 * only an intermediate revision had become history references. Runs inside
 * the transaction that accepts the revisions, before anything is written.
 */
export async function recordReferences(
  ctx: MutationCtx,
  args: {
    note: Pick<Doc<"notes">, "_id" | "lifecycle">;
    actor: Principal;
    before: ProseMirrorNode | null;
    after: ProseMirrorNode;
    seen?: Iterable<string>;
    sources?: Id<"notes">[];
  },
) {
  const previous = new Set(args.before ? attachmentIds(args.before) : []);
  const final = new Set(attachmentIds(args.after));
  if (final.size > MAX_NOTE_OBJECTS && final.size > previous.size)
    fail(
      "too_large",
      `A note can contain at most ${MAX_NOTE_OBJECTS} attachments.`,
    );
  const fresh = [...new Set([...final, ...(args.seen ?? [])])].filter(
    (raw) => !previous.has(raw),
  );
  if (fresh.length > MAX_NOTE_OBJECTS)
    fail(
      "too_large",
      `One change can add at most ${MAX_NOTE_OBJECTS} attachments.`,
    );
  const sources = (args.sources ?? []).slice(0, MAX_SOURCE_NOTES);
  const active = args.note.lifecycle === "active";
  const roles = new NoteRoles(ctx, args.actor);
  const budget = { rows: SEARCH_BUDGET };

  for (const raw of previous) {
    if (final.has(raw)) continue;
    const objectId = ctx.db.normalizeId("objects", raw);
    if (!objectId) continue;
    const ref = await refFor(ctx, args.note._id, objectId);
    if (!ref?.current) continue;
    await ctx.db.patch(ref._id, { current: false, live: false });
    const object = await ctx.db.get(objectId);
    if (object) await settleObject(ctx, object);
  }
  for (const raw of fresh) {
    const objectId = ctx.db.normalizeId("objects", raw);
    // Permanently deleted or never existed: the reference shows as deleted.
    const object = objectId ? await ctx.db.get(objectId) : null;
    if (!object) continue;
    const current = final.has(raw);
    const live = current && active;
    const ref = await refFor(ctx, args.note._id, object._id);
    if (ref) await ctx.db.patch(ref._id, { current, live });
    else {
      const decision = await mayUse(
        ctx,
        roles,
        args.actor,
        object,
        args.note._id,
        sources,
        budget,
      );
      if (decision === "unknown")
        await checkLater(ctx, args.note._id, object._id, args.actor._id);
      if (decision !== "yes") continue;
      await ctx.db.insert("objectRefs", {
        noteId: args.note._id,
        objectId: object._id,
        current,
        live,
      });
    }
    await settleObject(ctx, object);
  }
}

/** Finish an access search after the commit (files.verifyReference). */
async function checkLater(
  ctx: MutationCtx,
  noteId: Id<"notes">,
  objectId: Id<"objects">,
  actorId: Id<"principals">,
) {
  const pending = await ctx.db
    .query("referenceChecks")
    .withIndex("by_note_and_object_and_actor", (q) =>
      q.eq("noteId", noteId).eq("objectId", objectId).eq("actorId", actorId),
    )
    .first();
  if (pending) return;
  const checkId = await ctx.db.insert("referenceChecks", {
    noteId,
    objectId,
    actorId,
    cursor: null,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.files.verifyReference, { checkId });
}

/**
 * After a note is trashed, restored or permanently deleted: bring its
 * references in line, in scheduled batches (files.syncNote).
 */
export async function scheduleNoteSync(ctx: MutationCtx, noteId: Id<"notes">) {
  await ctx.scheduler.runAfter(0, internal.files.syncNote, { noteId });
}
