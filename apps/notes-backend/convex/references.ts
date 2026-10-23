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
 * - So a new reference is recorded only when the actor can prove, inside the
 *   accepting transaction, that they may already use the object (review
 *   round 2): they uploaded it; this note referenced it before (undo, history
 *   restore); or a named source note (`sources`, at most three) or a
 *   bounded search finds a note through which they can read it, as
 *   `authorizeRead` would allow. The proof is stored with the reference, which
 *   then stands on its own: losing access to the source later does not
 *   remove it. Without a proof the reference stays in the document but
 *   grants nothing and keeps nothing alive, now and later; access gained
 *   afterwards does not upgrade it. There is no deferred verification.
 * - An object with no live reference (current, in an active note) is in
 *   Trash from that moment; one that gains a live reference leaves Trash.
 *   Neither resets an existing Trash deadline.
 *
 * Reads per commit stay well inside Convex's limits (4,096 index ranges and
 * gets together): at most MAX_NOTE_OBJECTS new and MAX_NOTE_OBJECTS removed
 * objects; per new object about eight reads (the object, this note's row,
 * one per source, two search ranges while the search budget lasts, its live
 * references); per removed object three; and at most SEARCH_BUDGET +
 * MAX_SOURCE_NOTES notes' roles, three reads each, memoized.
 */

/** Distinct objects one note may reference at a time, and new ones per change. */
export const MAX_NOTE_OBJECTS = 200;
/** Notes one change may name as where its new attachments came from. */
export const MAX_SOURCE_NOTES = 3;
/** Reference rows a change examines, in total, searching for access. */
export const SEARCH_BUDGET = 48;
/** Reference rows the search examines at least, per object, while the budget lasts. */
const SEARCH_STEP = 8;
/** Rows handled by one scheduled cleanup step. */
export const REF_BATCH = 200;

type Ctx = QueryCtx | MutationCtx;

/** The R2 key of an object's bytes. */
export const OBJECT_KEY_PREFIX = "objects/";
export function objectKey(objectId: Id<"objects">): string {
  return OBJECT_KEY_PREFIX + objectId;
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

/** Why an actor may use an object in a note; stored with the reference. */
export type Proof =
  { proof: "uploader" } | { proof: "source" | "search"; noteId: Id<"notes"> };

/**
 * Whether the actor may use `object` in `noteId`, decided now and only now:
 * they uploaded it; a named source note, or one the bounded search finds,
 * lets them read it (as `authorizeRead` would: current content with read
 * access, history with edit access). Null when none holds within the bounds: the
 * reference then grants nothing, now or later.
 */
async function proveUse(
  ctx: MutationCtx,
  roles: NoteRoles,
  actor: Principal,
  object: Doc<"objects">,
  noteId: Id<"notes">,
  sources: Id<"notes">[],
  budget: { rows: number; objects: number },
): Promise<Proof | null> {
  if (object.uploaderId === actor._id) return { proof: "uploader" };
  // A named source counts as reads do: its current content for anyone who
  // can read it, its history for those who can edit it (review R3-2).
  for (const source of sources) {
    if (source === noteId || !(await roles.of(source))) continue;
    const ref = await refFor(ctx, source, object._id);
    if (ref && (await roles.grants(ref)))
      return { proof: "source", noteId: source };
  }
  // A fair share of what is left, at least SEARCH_STEP rows: one copied
  // object may use the whole budget, many share it.
  const share = Math.max(SEARCH_STEP, Math.ceil(budget.rows / budget.objects));
  budget.objects = Math.max(1, budget.objects - 1);
  for (const current of [true, false]) {
    if (budget.rows <= 0) return null;
    const take = Math.min(share, budget.rows);
    const rows = await ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) =>
        q.eq("objectId", object._id).eq("current", current),
      )
      .take(take);
    for (const ref of rows) {
      budget.rows--;
      if (ref.noteId !== noteId && (await roles.grants(ref)))
        return { proof: "search", noteId: ref.noteId };
    }
  }
  return null;
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
  const budget = { rows: SEARCH_BUDGET, objects: Math.max(1, fresh.length) };

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
    // This note referenced it before (undo, history restore): its own proof.
    const ref = await refFor(ctx, args.note._id, object._id);
    if (ref) await ctx.db.patch(ref._id, { current, live });
    else {
      const proof = await proveUse(
        ctx,
        roles,
        args.actor,
        object,
        args.note._id,
        sources,
        budget,
      );
      if (!proof) continue;
      await ctx.db.insert("objectRefs", {
        noteId: args.note._id,
        objectId: object._id,
        current,
        live,
        proof: proof.proof,
        ...(proof.proof === "uploader" ? {} : { proofNoteId: proof.noteId }),
      });
    }
    await settleObject(ctx, object);
  }
}

/**
 * After a note is trashed, restored or permanently deleted: bring its
 * references in line, in scheduled batches (files.syncNote).
 */
export async function scheduleNoteSync(ctx: MutationCtx, noteId: Id<"notes">) {
  await ctx.scheduler.runAfter(0, internal.files.syncNote, { noteId });
}
