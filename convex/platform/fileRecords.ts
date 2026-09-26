import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { fileScope, fileView, fileState, filePolicy, resourceTarget } from "./fileValues";
import { requireInstance } from "./scope";
import { authorizedResource } from "./resources";
import { fail, idempotencyKey, pagination } from "./errors";
const document = v.object({ ...schema.tables.files.validator.fields, _id: v.id("files"), _creationTime: v.number() });
const objectDocument = v.object({ ...schema.tables.fileObjects.validator.fields, _id: v.id("fileObjects"), _creationTime: v.number() });
export function view(file: Doc<"files">) {
  return { id: file._id, workspaceId: file.workspaceId, instanceId: file.instanceId, name: file.name, type: file.type, size: file.size, sha256: file.sha256, state: file.state, failure: file.failure };
}
export async function scopedFile(ctx: QueryCtx, args: { workspaceId: Id<"workspaces">; instanceId: Id<"appInstances">; fileId: Id<"files"> }, archived = false) {
  await requireInstance(ctx, args, { includeArchived: archived });
  const file = await ctx.db.get(args.fileId);
  if (!file || file.instanceId !== args.instanceId || file.workspaceId !== args.workspaceId) fail("NOT_FOUND");
  return file;
}
async function usage(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  let row = await ctx.db.query("fileUsage").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).unique();
  if (!row) row = await ctx.db.get(await ctx.db.insert("fileUsage", { workspaceId, reservedBytes: 0, pendingCount: 0 }));
  if (!row) fail("TEMPORARY");
  return row;
}
async function pendingFinished(ctx: MutationCtx, file: Doc<"files">) {
  if (file.state === "pending" || file.state === "verifying") {
    const row = await usage(ctx, file.workspaceId);
    if (row.pendingCount < 1) fail("TEMPORARY");
    await ctx.db.patch(row._id, { pendingCount: row.pendingCount - 1 });
  }
}
async function queueDeletion(ctx: MutationCtx, file: Doc<"files">) {
  if (file.state === "deleted" || file.state === "deleting") return;
  const ref = await ctx.db.query("fileReferences").withIndex("by_file", q => q.eq("fileId", file._id)).first();
  if (ref) fail("CONFLICT");
  await pendingFinished(ctx, file);
  await ctx.db.patch(file._id, { state: "deleting", generation: file.generation + 1, leaseUntil: 0, updatedAt: Date.now() });
  const objects = await ctx.db.query("fileObjects").withIndex("by_file", q => q.eq("fileId", file._id)).take(filePolicy.maxAttempts + 2);
  for (const object of objects) await ctx.db.patch(object._id, { cleanup: "queued", checkAfter: object.role === "staging" ? Math.max(Date.now(), file.maxUploadGrantExpiresAt + 1000) : Date.now() });
}
export const reserve = internalMutation({
  args: { workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), name: v.string(), type: v.string(), size: v.number(), sha256: v.string(), idempotencyKey: v.string(), expiresAt: v.number() }, returns: document,
  handler: async (ctx, args) => {
    await requireInstance(ctx, args); idempotencyKey(args.idempotencyKey);
    if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > filePolicy.bytes || !/^[a-f0-9]{64}$/.test(args.sha256) || args.name.length < 1 || args.name.length > 200 || /[\x00-\x1f\x7f]/.test(args.name) || !["image/png", "image/jpeg", "image/webp", "text/plain", "application/pdf", "application/octet-stream"].includes(args.type) || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + filePolicy.grantSeconds * 1000 + 5000) fail("VALIDATION");
    const fingerprint = JSON.stringify({ name: args.name, type: args.type, size: args.size, sha256: args.sha256 });
    const previous = await ctx.db.query("files").withIndex("by_receipt", q => q.eq("workspaceId", args.workspaceId).eq("instanceId", args.instanceId).eq("receiptKey", args.idempotencyKey)).unique();
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("CONFLICT");
      if (previous.state === "pending") await ctx.db.patch(previous._id, { maxUploadGrantExpiresAt: Math.max(previous.maxUploadGrantExpiresAt, args.expiresAt), updatedAt: Date.now() });
      return (await ctx.db.get(previous._id))!;
    }
    const row = await usage(ctx, args.workspaceId);
    if (row.reservedBytes + args.size > filePolicy.workspaceBytes || row.pendingCount >= filePolicy.pending) fail("RATE_LIMITED");
    const fileId = await ctx.db.insert("files", { workspaceId: args.workspaceId, instanceId: args.instanceId, name: args.name, type: args.type, size: args.size, sha256: args.sha256, state: "pending", generation: 0, leaseUntil: 0, maxUploadGrantExpiresAt: args.expiresAt, failure: null, updatedAt: Date.now(), receiptKey: args.idempotencyKey, fingerprint });
    const stagingObjectId = await ctx.db.insert("fileObjects", { fileId, key: `staging/${crypto.randomUUID()}`, role: "staging", generation: 0, cleanup: "queued", checkAfter: Date.now() + filePolicy.orphanMs, deletedOnce: false, failures: 0 });
    await ctx.db.patch(fileId, { stagingObjectId });
    await ctx.db.patch(row._id, { reservedBytes: row.reservedBytes + args.size, pendingCount: row.pendingCount + 1 });
    return (await ctx.db.get(fileId))!;
  },
});
export const inspect = internalQuery({ args: fileScope, returns: v.object({ file: document, staging: objectDocument }), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args);
  const staging = file.stagingObjectId && await ctx.db.get(file.stagingObjectId);
  if (!staging) fail("TEMPORARY");
  return { file, staging };
} });
export const claim = internalMutation({ args: fileScope, returns: v.object({ file: document, candidate: v.union(objectDocument, v.null()), staging: objectDocument }), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args);
  const staging = file.stagingObjectId && await ctx.db.get(file.stagingObjectId);
  if (!staging) fail("TEMPORARY");
  if (file.state === "ready") return { file, staging, candidate: null };
  if (file.state === "deleting" || file.state === "deleted") fail("NOT_FOUND");
  if (file.state === "verifying" && file.leaseUntil > Date.now()) fail("TEMPORARY");
  if (file.generation >= filePolicy.maxAttempts) fail("RATE_LIMITED");
  const generation = file.generation + 1;
  const candidateObjectId = await ctx.db.insert("fileObjects", { fileId: file._id, key: `ready/${crypto.randomUUID()}`, role: "candidate", generation, cleanup: "queued", checkAfter: Date.now() + filePolicy.leaseMs + filePolicy.retryMs, deletedOnce: false, failures: 0 });
  await ctx.db.patch(file._id, { state: "verifying", generation, candidateObjectId, leaseUntil: Date.now() + filePolicy.leaseMs, failure: null, updatedAt: Date.now() });
  return { file: (await ctx.db.get(file._id))!, staging, candidate: (await ctx.db.get(candidateObjectId))! };
} });
export const complete = internalMutation({ args: { ...fileScope, generation: v.number(), candidateObjectId: v.id("fileObjects") }, returns: fileView, handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args);
  if (file.state === "ready" && file.readyObjectId === args.candidateObjectId) return view(file);
  const candidate = await ctx.db.get(args.candidateObjectId);
  if (file.state !== "verifying" || file.generation !== args.generation || file.leaseUntil <= Date.now() || file.candidateObjectId !== args.candidateObjectId || !candidate || candidate.fileId !== file._id || candidate.generation !== args.generation || candidate.role !== "candidate") fail("CONFLICT");
  await pendingFinished(ctx, file);
  await ctx.db.patch(candidate._id, { role: "ready", cleanup: "retained" });
  await ctx.db.patch(file._id, { state: "ready", readyObjectId: candidate._id, leaseUntil: 0, failure: null, updatedAt: Date.now() });
  if (file.stagingObjectId) await ctx.db.patch(file.stagingObjectId, { checkAfter: Math.max(Date.now(), file.maxUploadGrantExpiresAt + 1000) });
  return view((await ctx.db.get(file._id))!);
} });
export const failed = internalMutation({ args: { ...fileScope, generation: v.number(), failure: v.union(v.literal("TEMPORARY"), v.literal("VALIDATION")) }, returns: v.null(), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args);
  if (file.state === "verifying" && file.generation === args.generation) await ctx.db.patch(file._id, { state: "pending", leaseUntil: 0, failure: args.failure, updatedAt: Date.now() });
  return null;
} });
export const get = query({ args: fileScope, returns: fileView, handler: async (ctx, args) => view(await scopedFile(ctx, args)) });
export const list = query({ args: { workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), state: fileState, cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) }, returns: v.object({ items: v.array(fileView), cursor: v.union(v.string(), v.null()) }), handler: async (ctx, args) => {
  await requireInstance(ctx, args); const limit = args.limit ?? 25; pagination(args.cursor, limit);
  const page = await ctx.db.query("files").withIndex("by_instance_state", q => q.eq("instanceId", args.instanceId).eq("state", args.state)).paginate({ numItems: limit, cursor: args.cursor });
  return { items: page.page.map(view), cursor: page.isDone ? null : page.continueCursor };
} });
export const cancel = mutation({ args: fileScope, returns: fileView, handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args, true); await queueDeletion(ctx, file); return view((await ctx.db.get(file._id))!);
} });
export const attach = mutation({ args: { ...fileScope, target: resourceTarget }, returns: v.null(), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args); await authorizedResource(ctx, args.workspaceId, args.target);
  if (file.state !== "ready" || args.target.instanceId !== file.instanceId) fail("NOT_FOUND");
  const previous = await ctx.db.query("fileReferences").withIndex("by_pair", q => q.eq("fileId", file._id).eq("target.resourceId", args.target.resourceId)).unique();
  if (previous) return null;
  const refs = await ctx.db.query("fileReferences").withIndex("by_resource", q => q.eq("target.resourceId", args.target.resourceId)).take(filePolicy.maxReferences);
  if (refs.length >= filePolicy.maxReferences) fail("RATE_LIMITED");
  await ctx.db.insert("fileReferences", { workspaceId: file.workspaceId, instanceId: file.instanceId, fileId: file._id, target: args.target }); return null;
} });
export const detach = mutation({ args: { ...fileScope, target: resourceTarget }, returns: v.null(), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args); await authorizedResource(ctx, args.workspaceId, args.target);
  if (args.target.instanceId !== file.instanceId) fail("NOT_FOUND");
  const ref = await ctx.db.query("fileReferences").withIndex("by_pair", q => q.eq("fileId", file._id).eq("target.resourceId", args.target.resourceId)).unique();
  if (ref) { await ctx.db.delete(ref._id); if (!await ctx.db.query("fileReferences").withIndex("by_file", q => q.eq("fileId", file._id)).first()) await queueDeletion(ctx, file); }
  return null;
} });
export const downloadInfo = internalQuery({ args: { ...fileScope, target: resourceTarget }, returns: v.object({ file: document, object: objectDocument }), handler: async (ctx, args) => {
  const file = await scopedFile(ctx, args); await authorizedResource(ctx, args.workspaceId, args.target);
  const reference = await ctx.db.query("fileReferences").withIndex("by_pair", q => q.eq("fileId", file._id).eq("target.resourceId", args.target.resourceId)).unique();
  const object = file.readyObjectId && await ctx.db.get(file.readyObjectId);
  if (file.state !== "ready" || args.target.instanceId !== file.instanceId || !reference || !object || object.role !== "ready") fail("NOT_FOUND");
  return { file, object };
} });
export const dueObjects = internalQuery({ args: {}, returns: v.array(objectDocument), handler: ctx => ctx.db.query("fileObjects").withIndex("by_cleanup_time", q => q.eq("cleanup", "queued").lte("checkAfter", Date.now())).take(20) });
export const cleanupClaim = internalMutation({ args: { objectId: v.id("fileObjects") }, returns: v.union(objectDocument, v.null()), handler: async (ctx, args) => {
  const object = await ctx.db.get(args.objectId); if (!object || object.cleanup !== "queued" || object.checkAfter > Date.now()) return null;
  const file = await ctx.db.get(object.fileId); if (!file) fail("TEMPORARY");
  if (file.readyObjectId === object._id && file.state === "ready") return null;
  if (file.state === "verifying" && file.leaseUntil > Date.now()) { await ctx.db.patch(object._id, { checkAfter: file.leaseUntil + 1000 }); return null; }
  if (object.role === "staging" && file.state === "pending") {
    if (file.updatedAt + filePolicy.orphanMs > Date.now()) { await ctx.db.patch(object._id, { checkAfter: file.updatedAt + filePolicy.orphanMs }); return null; }
    await queueDeletion(ctx, file);
  }
  if (object.role === "staging" && file.maxUploadGrantExpiresAt + 1000 > Date.now()) { await ctx.db.patch(object._id, { checkAfter: file.maxUploadGrantExpiresAt + 1000 }); return null; }
  if (object.role === "ready" && await ctx.db.query("fileReferences").withIndex("by_file", q => q.eq("fileId", file._id)).first()) fail("CONFLICT");
  await ctx.db.patch(object._id, { checkAfter: Date.now() + filePolicy.retryMs }); return object;
} });
export const cleaned = internalMutation({ args: { objectId: v.id("fileObjects"), success: v.boolean() }, returns: v.null(), handler: async (ctx, args) => {
  const object = await ctx.db.get(args.objectId); if (!object || object.cleanup !== "queued") return null;
  const file = await ctx.db.get(object.fileId); if (!file) fail("TEMPORARY");
  await ctx.db.patch(object._id, { deletedOnce: object.deletedOnce || args.success, failures: args.success ? 0 : object.failures + 1, checkAfter: Date.now() + (args.success ? filePolicy.orphanMs : filePolicy.retryMs) });
  if (args.success && file.state === "deleting" && (file.readyObjectId ? file.readyObjectId === object._id : file.stagingObjectId === object._id)) {
    const row = await usage(ctx, file.workspaceId); if (row.reservedBytes < file.size) fail("TEMPORARY");
    await ctx.db.patch(row._id, { reservedBytes: row.reservedBytes - file.size });
    await ctx.db.patch(file._id, { state: "deleted", updatedAt: Date.now() });
  }
  return null;
} });
export const abandonReady = internalMutation({ args: {}, returns: v.null(), handler: async (ctx) => {
  const files = await ctx.db.query("files").withIndex("by_state_time", q => q.eq("state", "ready").lt("updatedAt", Date.now() - filePolicy.orphanMs)).take(20);
  for (const file of files) if (!await ctx.db.query("fileReferences").withIndex("by_file", q => q.eq("fileId", file._id)).first()) await queueDeletion(ctx, file);
  return null;
} });
