import { attachmentIds } from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { atLeast, fail, noteRole, type Principal } from "./access";

/**
 * Object references (B1, D36–D42). Every accepted document records which
 * objects it references, in the same transaction, so access checks and the
 * object lifecycle never disagree with the note:
 *
 * - A reference grants access: a caller who can read a note can read the
 *   objects its current document references; editors (who may read history)
 *   also those its earlier revisions referenced.
 * - So a new reference is recorded only when the actor may already use the
 *   object: they uploaded it, this note referenced it before (undo, history
 *   restore), or they can read it through another note. Otherwise the
 *   document keeps the reference but it grants nothing and shows as
 *   unavailable, like a reference to a permanently deleted object.
 * - An object with no live reference (current, in an active note) is in
 *   Trash from that moment; one that gains a live reference leaves Trash.
 *   Neither resets an existing Trash deadline.
 */

/** Distinct objects one note may reference at a time. */
export const MAX_NOTE_OBJECTS = 200;
/** Other notes examined when checking whether an actor may use an object. */
const ACCESS_SCAN = 8;
/** Rows handled by one scheduled cleanup step. */
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

/**
 * Whether `principal` may use `object` without a reference in this note:
 * they uploaded it, or can read a note that references it now, or can edit
 * one that referenced it before.
 */
export async function canUseObject(
  ctx: Ctx,
  principal: Principal,
  object: Doc<"objects">,
  except?: Id<"notes">,
): Promise<boolean> {
  if (object.uploaderId === principal._id) return true;
  for (const current of [true, false]) {
    const refs = await ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) =>
        q.eq("objectId", object._id).eq("current", current),
      )
      .take(ACCESS_SCAN);
    for (const ref of refs) {
      if (ref.noteId === except) continue;
      const note = await ctx.db.get(ref.noteId);
      if (!note) continue;
      const role = await noteRole(ctx, principal, note);
      if (current ? role !== null : atLeast(role, "edit")) return true;
    }
  }
  return false;
}

/** Put an object in or out of Trash to match its live references. */
export async function settleObject(ctx: MutationCtx, objectId: Id<"objects">) {
  const object = await ctx.db.get(objectId);
  if (!object) return;
  const live = await ctx.db
    .query("objectRefs")
    .withIndex("by_object_and_live", (q) =>
      q.eq("objectId", objectId).eq("live", true),
    )
    .first();
  if (live && object.trashedAt !== undefined)
    await ctx.db.patch(objectId, { trashedAt: undefined });
  else if (!live && object.trashedAt === undefined)
    await ctx.db.patch(objectId, { trashedAt: Date.now() });
}

/**
 * Record the objects a note's newly accepted document references, given the
 * previous accepted document (null for a new note). Runs inside the
 * transaction that accepts the document.
 */
export async function recordReferences(
  ctx: MutationCtx,
  args: {
    note: Pick<Doc<"notes">, "_id" | "lifecycle">;
    actor: Principal;
    before: ProseMirrorNode | null;
    after: ProseMirrorNode;
  },
) {
  const previous = new Set(args.before ? attachmentIds(args.before) : []);
  const next = attachmentIds(args.after);
  if (next.length > MAX_NOTE_OBJECTS && next.length > previous.size)
    fail(
      "too_large",
      `A note can contain at most ${MAX_NOTE_OBJECTS} attachments.`,
    );
  const nextSet = new Set(next);
  const live = args.note.lifecycle === "active";
  for (const raw of previous) {
    if (nextSet.has(raw)) continue;
    const objectId = ctx.db.normalizeId("objects", raw);
    if (!objectId) continue;
    const ref = await refFor(ctx, args.note._id, objectId);
    if (!ref?.current) continue;
    await ctx.db.patch(ref._id, { current: false, live: false });
    await settleObject(ctx, objectId);
  }
  for (const raw of next) {
    if (previous.has(raw)) continue;
    const objectId = ctx.db.normalizeId("objects", raw);
    // Permanently deleted or never existed: the reference shows as deleted.
    const object = objectId ? await ctx.db.get(objectId) : null;
    if (!object) continue;
    const ref = await refFor(ctx, args.note._id, object._id);
    if (ref) await ctx.db.patch(ref._id, { current: true, live });
    else if (await canUseObject(ctx, args.actor, object, args.note._id))
      await ctx.db.insert("objectRefs", {
        noteId: args.note._id,
        objectId: object._id,
        current: true,
        live,
      });
    else continue;
    await settleObject(ctx, object._id);
  }
}

/**
 * After a note is trashed, restored or permanently deleted: bring its
 * references in line, in scheduled batches (files.syncNote).
 */
export async function scheduleNoteSync(ctx: MutationCtx, noteId: Id<"notes">) {
  await ctx.scheduler.runAfter(0, internal.files.syncNote, { noteId });
}
