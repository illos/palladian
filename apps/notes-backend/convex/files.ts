import {
  FILE_NAME_LIMIT,
  isFileName,
  isMimeType,
  isSafeImageSource,
} from "@palladian/notes-core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  atLeast,
  fail,
  getPrincipal,
  loadNote,
  loadNotebook,
  noteRole,
  requirePrincipal,
  type Principal,
} from "./access";
import { agentIssuer } from "./config";
import { digestOf } from "./documents";
import { hashToken, newToken } from "./invitations";
import { DEFAULT_RETENTION_DAYS } from "./lifecycle";
import {
  MAX_NOTE_OBJECTS,
  objectKey,
  REF_BATCH,
  refFor,
  settleObject,
} from "./references";

/**
 * Files (B1). An upload is a ticket from Convex, then bytes to the Worker:
 *
 * 1. `createUpload` (the app or an agent, with edit access to the note, or to
 *    the notebook for a new file note) creates a pending object and returns a
 *    one-hour upload ticket, once. The object ID is fixed here, so no retry
 *    can create a second object.
 * 2. The Worker takes `PUT /files/upload/<objectId>` with the ticket, reads
 *    the expected size and SHA-256 with `admitUpload` (which grants a
 *    write lease), checks the bytes, writes R2 key `objects/<objectId>`
 *    before the lease ends, and calls `finalize`. Both calls are
 *    authenticated as the file service: a JWT the Worker signs with its agent
 *    key, subject `service:files` (no person or agent is resolved from it).
 * 3. Reads: the Worker asks `authorizeRead` with the caller's own Convex
 *    token, or `authorizePublicRead` with a public link, before serving bytes.
 *
 * The object lifecycle (references, Trash, purge) is in references.ts and
 * the sweeps below. Purged objects' bytes are queued in `objectDeletions`,
 * which the Worker drains (`deletionBatch`, `confirmDeletions`).
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const FILES_SERVICE_SUBJECT = "service:files";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How long an upload ticket works. */
export const TICKET_TTL_MS = 60 * MINUTE_MS;
/** An upload accepted before its ticket expired may still finalize this long after. */
export const FINALIZE_GRACE_MS = 15 * MINUTE_MS;
/** How long a failed upload's record stays visible to its uploader. */
export const FAILED_TTL_MS = DAY_MS;
/** A finalized object no note ever referenced is removed after this. */
export const ORPHAN_TTL_MS = 7 * DAY_MS;
/** Unexpired pending uploads one person or agent may hold. */
export const MAX_PENDING_UPLOADS = 20;
/**
 * How long the Worker may take, after admitting an upload, to read and check
 * the bytes before writing them. It refuses to write once this has passed.
 */
export const UPLOAD_LEASE_MS = 15 * MINUTE_MS;
/**
 * How long after an upload's lease its bytes' deletion keeps being repeated.
 * The Worker refuses to start a write after the lease and deletes a late one
 * itself; this covers a write that still lands later, for any reason (a
 * slow R2 write, clock differences, a Worker that died before cleaning up).
 */
export const TOMBSTONE_MS = 7 * DAY_MS;
/** A tombstone is due again this long after each confirmed pass. */
export const TOMBSTONE_PASS_MS = 12 * 60 * MINUTE_MS;
/** Tickets kept per object (each retried request adds one). */
const MAX_TICKETS = 5;
const SWEEP_BATCH = 100;
const DELETION_BATCH = 100;

type Ctx = QueryCtx | MutationCtx;

const objectState = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("failed"),
);
const objectMeta = {
  name: v.string(),
  mimeType: v.string(),
  size: v.number(),
  sha256: v.string(),
};

/** The Worker, calling as the file service; never a person or agent. */
async function requireFilesService(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  const issuer = agentIssuer();
  if (
    !identity ||
    !issuer ||
    identity.issuer !== issuer ||
    identity.subject !== FILES_SERVICE_SUBJECT
  )
    fail("unauthenticated", "Only the file service can do this.");
}

/** A usable file name: control characters removed, at most 255 characters. */
function cleanName(raw: string): string {
  let name = raw.replace(/\p{Cc}/gu, " ").trim();
  if (name.length > FILE_NAME_LIMIT) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    const chars = Array.from(name.slice(0, name.length - extension.length));
    while (chars.join("").length > FILE_NAME_LIMIT - extension.length)
      chars.pop();
    name = chars.join("").trimEnd() + extension;
  }
  if (!isFileName(name)) fail("invalid", "Give the file a name.");
  return name;
}

/** The declared media type without parameters; unknown types are binary. */
function cleanMimeType(raw: string): string {
  const type = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return isMimeType(type) ? type : "application/octet-stream";
}

async function resolveTarget(
  ctx: MutationCtx,
  actor: Principal,
  args: { noteId?: Id<"notes">; notebookId?: Id<"notebooks"> },
): Promise<{
  ownerId: Id<"principals">;
  noteId?: Id<"notes">;
  notebookId?: Id<"notebooks">;
}> {
  if (args.noteId && !args.notebookId) {
    const { note } = await loadNote(ctx, actor, args.noteId, "edit");
    if (note.lifecycle !== "active")
      fail("trashed", "Restore this note from Trash before adding files.");
    return { ownerId: note.ownerId, noteId: note._id };
  }
  if (args.notebookId && !args.noteId) {
    const { notebook } = await loadNotebook(
      ctx,
      actor,
      args.notebookId,
      "edit",
    );
    return { ownerId: notebook.ownerId, notebookId: notebook._id };
  }
  fail("invalid", "Upload to exactly one note or notebook.");
}

/** Ask for an upload ticket. Needs edit access to the target. */
export const createUpload = mutation({
  args: {
    noteId: v.optional(v.id("notes")),
    notebookId: v.optional(v.id("notebooks")),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    sha256: v.string(),
    /** Stable per logical upload; a retry returns the same object. */
    requestId: v.optional(v.string()),
  },
  returns: v.object({
    objectId: v.id("objects"),
    state: objectState,
    /** Present only for a pending upload; shown once, never stored. */
    ticket: v.union(v.string(), v.null()),
    expiresAt: v.union(v.number(), v.null()),
    name: v.string(),
    mimeType: v.string(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const name = cleanName(args.name);
    const mimeType = cleanMimeType(args.mimeType);
    if (!Number.isSafeInteger(args.size) || args.size < 1)
      fail("invalid", "The file is empty.");
    if (args.size > MAX_UPLOAD_BYTES)
      fail("too_large", "Files can be at most 25 MB.");
    const sha256 = args.sha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256))
      fail("invalid", "sha256 must be the file's hex SHA-256.");
    if (
      args.requestId !== undefined &&
      (args.requestId.length < 8 || args.requestId.length > 128)
    )
      fail("invalid", "request_id must be 8 to 128 characters.");
    const target = await resolveTarget(ctx, actor, args);
    const now = Date.now();
    const digest = await digestOf([
      "upload",
      target.noteId ?? target.notebookId,
      name,
      mimeType,
      args.size,
      sha256,
    ]);
    if (args.requestId !== undefined) {
      const prior = await ctx.db
        .query("objects")
        .withIndex("by_uploader_and_request", (q) =>
          q.eq("uploaderId", actor._id).eq("requestId", args.requestId),
        )
        .unique();
      if (prior) {
        if (prior.requestDigest !== digest)
          fail(
            "conflict",
            "This request_id was already used for a different upload.",
          );
        if (prior.state !== "pending")
          return {
            objectId: prior._id,
            state: prior.state,
            ticket: null,
            expiresAt: null,
            name: prior.name,
            mimeType: prior.mimeType,
            replayed: true,
          };
        // The first answer may have been lost: a new ticket for the same
        // object. Earlier tickets keep working until the object expires.
        const ticket = newToken();
        const expiresAt = now + TICKET_TTL_MS;
        await ctx.db.patch(prior._id, {
          ticketHashes: [...prior.ticketHashes, await hashToken(ticket)].slice(
            -MAX_TICKETS,
          ),
          expiresAt,
        });
        return {
          objectId: prior._id,
          state: "pending" as const,
          ticket,
          expiresAt,
          name: prior.name,
          mimeType: prior.mimeType,
          replayed: true,
        };
      }
    }
    const pending = await ctx.db
      .query("objects")
      .withIndex("by_uploader_and_state_and_expires_at", (q) =>
        q
          .eq("uploaderId", actor._id)
          .eq("state", "pending")
          .gt("expiresAt", now),
      )
      .take(MAX_PENDING_UPLOADS);
    if (pending.length >= MAX_PENDING_UPLOADS)
      fail(
        "too_large",
        "Too many uploads are in progress. Wait for some to finish.",
      );
    const ticket = newToken();
    const expiresAt = now + TICKET_TTL_MS;
    const objectId = await ctx.db.insert("objects", {
      ownerId: target.ownerId,
      uploaderId: actor._id,
      ...(target.noteId ? { noteId: target.noteId } : {}),
      ...(target.notebookId ? { notebookId: target.notebookId } : {}),
      name,
      mimeType,
      size: args.size,
      sha256,
      state: "pending",
      ticketHashes: [await hashToken(ticket)],
      expiresAt,
      ...(args.requestId !== undefined
        ? { requestId: args.requestId, requestDigest: digest }
        : {}),
      createdAt: now,
    });
    return {
      objectId,
      state: "pending" as const,
      ticket,
      expiresAt,
      name,
      mimeType,
      replayed: false,
    };
  },
});

/** The object a ticket was issued for, or null (unknown object or ticket). */
async function ticketObject(
  ctx: Ctx,
  args: { objectId: string; ticket: string },
): Promise<{ object: Doc<"objects"> | null; ticketOk: boolean }> {
  const id = ctx.db.normalizeId("objects", args.objectId);
  const object = id ? await ctx.db.get(id) : null;
  if (!object || args.ticket.length < 20 || args.ticket.length > 200)
    return { object, ticketOk: false };
  const hash = await hashToken(args.ticket);
  return { object, ticketOk: object.ticketHashes.includes(hash) };
}

function expired(object: Doc<"objects">, now: number) {
  return now > (object.expiresAt ?? 0);
}

/**
 * File service: admit an upload for this ticket. Answers what the Worker
 * should accept and, while the object is pending, grants a lease: the Worker
 * writes the bytes only before `leaseUntil`, and deleting the object's bytes
 * keeps being repeated until TOMBSTONE_MS after the lease (a tombstone).
 */
export const admitUpload = mutation({
  args: { objectId: v.string(), ticket: v.string() },
  returns: v.union(
    v.object({
      status: v.literal("pending"),
      size: v.number(),
      sha256: v.string(),
      mimeType: v.string(),
      leaseUntil: v.number(),
    }),
    v.object({
      status: v.literal("ready"),
      size: v.number(),
      sha256: v.string(),
    }),
    v.object({ status: v.literal("gone") }),
    v.object({ status: v.literal("denied") }),
  ),
  handler: async (ctx, args) => {
    await requireFilesService(ctx);
    const { object, ticketOk } = await ticketObject(ctx, args);
    if (!object || !ticketOk) return { status: "denied" as const };
    if (object.state === "ready")
      return {
        status: "ready" as const,
        size: object.size,
        sha256: object.sha256,
      };
    const now = Date.now();
    if (object.state === "failed" || expired(object, now))
      return { status: "gone" as const };
    const leaseUntil = Math.max(object.leaseUntil ?? 0, now + UPLOAD_LEASE_MS);
    await ctx.db.patch(object._id, { leaseUntil });
    return {
      status: "pending" as const,
      size: object.size,
      sha256: object.sha256,
      mimeType: object.mimeType,
      leaseUntil,
    };
  },
});

/**
 * File service: the bytes are in R2 and match the ticket. Idempotent: an
 * object already finalized answers "ready". "gone" means the object will
 * never be ready (failed, expired or deleted), so the Worker removes what it
 * wrote.
 */
export const finalize = mutation({
  args: {
    objectId: v.string(),
    ticket: v.string(),
    size: v.number(),
    sha256: v.string(),
  },
  returns: v.union(
    v.object({ status: v.literal("ready") }),
    v.object({ status: v.literal("gone") }),
    v.object({ status: v.literal("denied") }),
  ),
  handler: async (ctx, args) => {
    await requireFilesService(ctx);
    const { object, ticketOk } = await ticketObject(ctx, args);
    if (!object) return { status: "gone" as const };
    if (!ticketOk) return { status: "denied" as const };
    if (object.state === "ready") return { status: "ready" as const };
    if (object.state === "failed") return { status: "gone" as const };
    const now = Date.now();
    if (now > (object.expiresAt ?? 0) + FINALIZE_GRACE_MS) {
      await failObject(ctx, object);
      return { status: "gone" as const };
    }
    if (args.size !== object.size || args.sha256 !== object.sha256)
      fail("invalid", "The uploaded bytes do not match the ticket.");
    const live = await ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_live", (q) =>
        q.eq("objectId", object._id).eq("live", true),
      )
      .first();
    await ctx.db.patch(object._id, {
      state: "ready",
      readyAt: now,
      expiresAt: undefined,
      // Not yet in any active note: counts as unused from now.
      trashedAt: live ? undefined : (object.trashedAt ?? now),
    });
    return { status: "ready" as const };
  },
});

/** Stop an upload: a pending one fails; a finished one no note uses is deleted. */
export const cancelUpload = mutation({
  args: { objectId: v.id("objects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const object = await ctx.db.get(args.objectId);
    if (!object || object.uploaderId !== actor._id)
      fail("not_found", "Upload not found.");
    if (object.state === "pending") await failObject(ctx, object);
    else if (object.state === "ready") {
      const used = await ctx.db
        .query("objectRefs")
        .withIndex("by_object_and_current", (q) => q.eq("objectId", object._id))
        .first();
      if (used)
        fail(
          "invalid",
          "This file is in a note; remove it from the note instead.",
        );
      await purgeObject(ctx, object, true);
    }
    return null;
  },
});

/**
 * Whether the caller may read an object's bytes through a note: they can
 * read the note and its current document references the object, or they can
 * edit it (and so read its history) and an earlier revision referenced it.
 * The Worker calls this with the caller's own Convex token.
 */
export const authorizeRead = query({
  args: { noteId: v.string(), objectId: v.string() },
  returns: v.union(
    v.object({ access: v.literal("granted"), ...objectMeta }),
    v.object({ access: v.literal("unauthenticated") }),
    v.object({ access: v.literal("denied") }),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return { access: "unauthenticated" as const };
    const denied = { access: "denied" as const };
    const noteId = ctx.db.normalizeId("notes", args.noteId);
    const objectId = ctx.db.normalizeId("objects", args.objectId);
    if (!noteId || !objectId) return denied;
    const note = await ctx.db.get(noteId);
    const role = note ? await noteRole(ctx, principal, note) : null;
    if (!role) return denied;
    const object = await ctx.db.get(objectId);
    if (!object || object.state !== "ready") return denied;
    const ref = await refFor(ctx, noteId, objectId);
    if (!ref || (!ref.current && !atLeast(role, "edit"))) return denied;
    return {
      access: "granted" as const,
      name: object.name,
      mimeType: object.mimeType,
      size: object.size,
      sha256: object.sha256,
    };
  },
});

/** A public link serves only the objects its note's current content uses. */
export const authorizePublicRead = query({
  args: { token: v.string(), objectId: v.string() },
  returns: v.union(v.null(), v.object(objectMeta)),
  handler: async (ctx, args) => {
    if (args.token.length < 20 || args.token.length > 100) return null;
    const link = await ctx.db
      .query("publicLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!link || link.revokedAt !== undefined) return null;
    const note = await ctx.db.get(link.noteId);
    if (!note || note.lifecycle !== "active") return null;
    const objectId = ctx.db.normalizeId("objects", args.objectId);
    const object = objectId ? await ctx.db.get(objectId) : null;
    if (!object || object.state !== "ready") return null;
    const ref = await refFor(ctx, note._id, object._id);
    if (!ref?.current) return null;
    return {
      name: object.name,
      mimeType: object.mimeType,
      size: object.size,
      sha256: object.sha256,
    };
  },
});

/**
 * The objects a note's current content references, for display. A reference
 * in the document that is missing here is to an object that was permanently
 * deleted (or never usable): show the "attachment permanently deleted"
 * placeholder (D40).
 */
export const noteObjects = query({
  args: { noteId: v.id("notes") },
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        objectId: v.id("objects"),
        ...objectMeta,
        state: objectState,
        trashed: v.boolean(),
      }),
    ),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const note = await ctx.db.get(args.noteId);
    if (!note || !(await noteRole(ctx, principal, note))) return null;
    const refs = await ctx.db
      .query("objectRefs")
      .withIndex("by_note_and_current_and_live", (q) =>
        q.eq("noteId", note._id).eq("current", true),
      )
      .take(MAX_NOTE_OBJECTS);
    const objects = [];
    for (const ref of refs) {
      const object = await ctx.db.get(ref.objectId);
      if (object)
        objects.push({
          objectId: object._id,
          name: object.name,
          mimeType: object.mimeType,
          size: object.size,
          sha256: object.sha256,
          state: object.state,
          trashed: object.trashedAt !== undefined,
        });
    }
    return objects;
  },
});

/**
 * File service: R2 keys due for a deletion pass now.
 * A mutation, not a query: which deletions are due depends on the time, and
 * a cached query result would keep answering for an earlier time.
 */
export const deletionBatch = mutation({
  args: { limit: v.number() },
  returns: v.array(v.object({ id: v.id("objectDeletions"), key: v.string() })),
  handler: async (ctx, args) => {
    await requireFilesService(ctx);
    const limit = Math.max(1, Math.min(DELETION_BATCH, Math.floor(args.limit)));
    const rows = await ctx.db
      .query("objectDeletions")
      .withIndex("by_not_before", (q) => q.lte("notBefore", Date.now()))
      .take(limit);
    return rows.map((row) => ({ id: row._id, key: row.key }));
  },
});

/** File service: these keys were deleted from R2 in this pass. */
export const confirmDeletions = mutation({
  args: { ids: v.array(v.id("objectDeletions")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireFilesService(ctx);
    if (args.ids.length > DELETION_BATCH)
      fail("invalid", "Too many deletions in one call.");
    const now = Date.now();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      // Retire it once seven days have passed since the lease; until then
      // the next daily sweep deletes the key again.
      if (now >= (row.retainUntil ?? 0)) await ctx.db.delete(id);
      else
        await ctx.db.patch(id, {
          passes: (row.passes ?? 0) + 1,
          lastPassAt: now,
          notBefore: now + TOMBSTONE_PASS_MS,
        });
    }
    return null;
  },
});

/**
 * Queue an object's bytes for deletion as a tombstone: the next sweep
 * deletes the key, and every daily sweep deletes it again until seven days
 * after the object's upload lease ended (one pass if it never had one), so
 * a write that lands after a pass is removed by the next. Residual risk: a
 * write that completes more than seven days after its lease, from a Worker
 * that died before its own cleanup, would stay as unreachable bytes.
 */
async function enqueueDeletion(ctx: MutationCtx, object: Doc<"objects">) {
  const now = Date.now();
  await ctx.db.insert("objectDeletions", {
    key: objectKey(object._id),
    requestedAt: now,
    notBefore: now,
    // Never admitted: no write can land, one pass is enough.
    retainUntil:
      object.leaseUntil === undefined ? now : object.leaseUntil + TOMBSTONE_MS,
    passes: 0,
  });
}

/** A pending upload that will never finish: its bytes, if any, are removed. */
async function failObject(ctx: MutationCtx, object: Doc<"objects">) {
  await ctx.db.patch(object._id, {
    state: "failed",
    expiresAt: Date.now() + FAILED_TTL_MS,
  });
  await enqueueDeletion(ctx, object);
}

/**
 * Permanently delete an object: the record now, its bytes through the
 * deletion queue, its reference rows in batches. References left in note
 * documents then show the "permanently deleted" placeholder.
 */
async function purgeObject(
  ctx: MutationCtx,
  object: Doc<"objects">,
  bytes: boolean,
) {
  await ctx.db.delete(object._id);
  if (bytes) await enqueueDeletion(ctx, object);
  const ref = await ctx.db
    .query("objectRefs")
    .withIndex("by_object_and_current", (q) => q.eq("objectId", object._id))
    .first();
  if (ref)
    await ctx.scheduler.runAfter(0, internal.files.forgetObject, {
      objectId: object._id,
    });
}

/** Remove a deleted object's reference rows, in batches. */
export const forgetObject = internalMutation({
  args: { objectId: v.id("objects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const refs = await ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) =>
        q.eq("objectId", args.objectId),
      )
      .take(REF_BATCH);
    for (const ref of refs) await ctx.db.delete(ref._id);
    if (refs.length === REF_BATCH)
      await ctx.scheduler.runAfter(0, internal.files.forgetObject, args);
    return null;
  },
});

/**
 * Bring a note's references in line with its lifecycle, in batches; scheduled
 * after it is trashed, restored or permanently deleted. Reads the note's
 * state when it runs, so it is safe to run late, twice or out of order.
 *
 * - Active or trashed: its current references become live or not, and their
 *   objects leave or enter Trash (D41, D42).
 * - Deleted: its reference rows go. An object no other note has ever
 *   referenced is permanently deleted with it; others follow their own Trash
 *   retention (purgeExpired).
 */
export const syncNote = internalMutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    let rows: Doc<"objectRefs">[];
    if (!note) {
      rows = await ctx.db
        .query("objectRefs")
        .withIndex("by_note_and_object", (q) => q.eq("noteId", args.noteId))
        .take(REF_BATCH);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        const other = await ctx.db
          .query("objectRefs")
          .withIndex("by_object_and_current", (q) =>
            q.eq("objectId", row.objectId),
          )
          .first();
        const object = await ctx.db.get(row.objectId);
        if (!object) continue;
        if (other) await settleObject(ctx, object);
        else await purgeObject(ctx, object, true);
      }
    } else {
      const live = note.lifecycle === "active";
      rows = await ctx.db
        .query("objectRefs")
        .withIndex("by_note_and_current_and_live", (q) =>
          q.eq("noteId", note._id).eq("current", true).eq("live", !live),
        )
        .take(REF_BATCH);
      for (const row of rows) {
        await ctx.db.patch(row._id, { live });
        const object = await ctx.db.get(row.objectId);
        if (object) await settleObject(ctx, object);
      }
    }
    if (rows.length === REF_BATCH)
      await ctx.scheduler.runAfter(0, internal.files.syncNote, args);
    return null;
  },
});

/** Hourly: expired uploads fail; failed records past their time are removed. */
export const expireUploads = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("objects")
      .withIndex("by_state_and_expires_at", (q) =>
        q.eq("state", "pending").lt("expiresAt", now - FINALIZE_GRACE_MS),
      )
      .take(SWEEP_BATCH);
    for (const object of stale) await failObject(ctx, object);
    const old = await ctx.db
      .query("objects")
      .withIndex("by_state_and_expires_at", (q) =>
        q.eq("state", "failed").lt("expiresAt", now),
      )
      .take(SWEEP_BATCH);
    // Their bytes were queued for deletion when they failed.
    for (const object of old) await purgeObject(ctx, object, false);
    if (stale.length === SWEEP_BATCH || old.length === SWEEP_BATCH)
      await ctx.scheduler.runAfter(0, internal.files.expireUploads, {});
    return null;
  },
});

/**
 * Daily: permanently delete objects whose time in Trash has passed the
 * owner's retention (D36; manual-only retention keeps them), and finalized
 * objects no note ever referenced after ORPHAN_TTL_MS. Conservative for Q11:
 * an object a note's current content still references, even a note in Trash
 * or another owner's note, is never deleted here.
 */
export const purgeExpired = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("objects")
      .withIndex("by_state_and_trashed_at", (q) =>
        q
          .eq("state", "ready")
          .gt("trashedAt", 0)
          .lt("trashedAt", now - DAY_MS),
      )
      .paginate({ numItems: SWEEP_BATCH, cursor: args.cursor ?? null });
    const retention = new Map<Id<"principals">, number>();
    for (const object of page.page) {
      const trashedAt = object.trashedAt ?? now;
      const anyRef = await ctx.db
        .query("objectRefs")
        .withIndex("by_object_and_current", (q) => q.eq("objectId", object._id))
        .first();
      if (!anyRef && trashedAt <= now - ORPHAN_TTL_MS) {
        await purgeObject(ctx, object, true);
        continue;
      }
      const inUse = await ctx.db
        .query("objectRefs")
        .withIndex("by_object_and_current", (q) =>
          q.eq("objectId", object._id).eq("current", true),
        )
        .first();
      if (inUse) continue;
      if (!retention.has(object.ownerId)) {
        const owner = await ctx.db.get(object.ownerId);
        retention.set(
          object.ownerId,
          owner?.trashRetentionDays ?? DEFAULT_RETENTION_DAYS,
        );
      }
      const days = retention.get(object.ownerId)!;
      if (days > 0 && trashedAt <= now - days * DAY_MS)
        await purgeObject(ctx, object, true);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.files.purgeExpired, {
        cursor: page.continueCursor,
      });
    return null;
  },
});

/**
 * Operator scan, read-only, for review finding F7: image sources that start
 * with `attachment:` (any case, any spaces) but are not exactly an object
 * reference, in current content, checkpoints or the step log. B2 tolerates
 * these in stored documents (they open, edit and grant nothing) and refuses
 * them in new content. Run before deploying, for example:
 *
 *   npx convex run --prod files:scanAttachmentSources \
 *     '{"table":"noteSteps","cursor":null,"numItems":200}'
 *
 * repeating with `continueCursor` until `isDone`. Reports note IDs,
 * revisions and counts only, never content.
 */
export const scanAttachmentSources = internalQuery({
  args: {
    table: v.union(
      v.literal("noteContent"),
      v.literal("noteCheckpoints"),
      v.literal("noteSteps"),
    ),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    scanned: v.number(),
    loose: v.array(
      v.object({
        noteId: v.id("notes"),
        revision: v.union(v.number(), v.null()),
        sources: v.number(),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.max(1, Math.min(200, Math.floor(args.numItems)));
    // Documents can be large; stop a page early rather than read too much.
    const options = {
      cursor: args.cursor,
      numItems,
      maximumBytesRead: 4_000_000,
    };
    const result =
      args.table === "noteContent"
        ? await ctx.db.query("noteContent").paginate(options)
        : args.table === "noteCheckpoints"
          ? await ctx.db.query("noteCheckpoints").paginate(options)
          : await ctx.db.query("noteSteps").paginate(options);
    const loose = [];
    for (const row of result.page) {
      const json = "doc" in row ? row.doc : row.step;
      const sources = looseSources(JSON.parse(json));
      if (sources)
        loose.push({
          noteId: row.noteId,
          revision: args.table === "noteContent" ? null : row.revision,
          sources,
        });
    }
    return {
      scanned: result.page.length,
      loose,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/** Count loose `attachment:` image sources in a document or step's JSON. */
function looseSources(value: unknown): number {
  let count = 0;
  const loose = (src: unknown) =>
    typeof src === "string" &&
    /^\s*attachment:/i.test(src) &&
    !isSafeImageSource(src);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const attrs = record.attrs as Record<string, unknown> | undefined;
      if (record.type === "image" && attrs && loose(attrs.src)) count++;
      // An attribute step pointing an image at a new source.
      if (
        record.stepType === "attr" &&
        record.attr === "src" &&
        loose(record.value)
      )
        count++;
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(value);
  return count;
}
