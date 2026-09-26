"use node";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { fileScope, fileView, resourceTarget, filePolicy } from "./fileValues";
import { fail } from "./errors";
function storage() {
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const sessionToken = process.env.R2_SESSION_TOKEN;
  const expiration = Number(process.env.R2_CREDENTIAL_EXPIRES_AT);
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey || !Number.isSafeInteger(expiration) || expiration <= Date.now() + 10000) fail("TEMPORARY");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".r2.cloudflarestorage.com") || url.username || url.password || url.search || url.hash) fail("TEMPORARY");
  return { bucket, expiration, client: new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }) };
}
function expiry(maxSeconds: number, expiration: number) {
  const seconds = Math.min(maxSeconds, Math.floor((expiration - Date.now()) / 1000) - 5);
  if (seconds < 1) fail("TEMPORARY");
  return { seconds, at: Date.now() + seconds * 1000 };
}
function validationError() { return new ConvexError({ code: "VALIDATION", message: "The uploaded file did not match its declared content." }); }
function validSignature(type: string, prefix: Buffer) {
  if (type === "image/png") return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  if (type === "image/webp") return prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP";
  if (type === "application/pdf") return prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  return true;
}
function fileViewOf(file: { _id: import("../_generated/dataModel").Id<"files">; workspaceId: import("../_generated/dataModel").Id<"workspaces">; instanceId: import("../_generated/dataModel").Id<"appInstances">; name: string; type: string; size: number; sha256: string; state: "pending" | "verifying" | "ready" | "deleting" | "deleted"; failure: "TEMPORARY" | "VALIDATION" | null }) {
  return { id: file._id, workspaceId: file.workspaceId, instanceId: file.instanceId, name: file.name, type: file.type, size: file.size, sha256: file.sha256, state: file.state, failure: file.failure };
}
export const requestUpload = action({
  args: { workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), name: v.string(), type: v.string(), size: v.number(), sha256: v.string(), idempotencyKey: v.string() },
  returns: v.object({ file: fileView, upload: v.union(v.null(), v.object({ url: v.string(), expiresAt: v.number(), headers: v.object({ "Content-Type": v.string(), "If-None-Match": v.string() }) })) }),
  handler: async (ctx, args) => {
    const config = storage(); const grant = expiry(filePolicy.grantSeconds, config.expiration);
    const file = await ctx.runMutation(internal.platform.fileRecords.reserve, { ...args, expiresAt: grant.at });
    if (file.state !== "pending") return { file: fileViewOf(file), upload: null };
    const scope = { workspaceId: args.workspaceId, instanceId: args.instanceId, fileId: file._id };
    const before = await ctx.runQuery(internal.platform.fileRecords.inspect, scope);
    const url = await getSignedUrl(config.client, new PutObjectCommand({ Bucket: config.bucket, Key: before.staging.key, ContentType: file.type, ContentLength: file.size, IfNoneMatch: "*" }), { expiresIn: grant.seconds, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
    const after = await ctx.runQuery(internal.platform.fileRecords.inspect, scope);
    if (after.file.state !== "pending" || after.file.generation !== before.file.generation) fail("CONFLICT");
    return { file: fileViewOf(after.file), upload: { url, expiresAt: grant.at, headers: { "Content-Type": file.type, "If-None-Match": "*" } } };
  },
});
export const finalize = action({ args: fileScope, returns: fileView, handler: async (ctx, args) => {
  const claimed = await ctx.runMutation(internal.platform.fileRecords.claim, args);
  if (claimed.candidate === null) return fileViewOf(claimed.file);
  const config = storage();
  const candidate = claimed.candidate;
  try {
    // One controller bounds all external work below the persisted claim lease.
    const signal = AbortSignal.timeout(100000);
    const staging = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: claimed.staging.key }), { abortSignal: signal });
    if (!staging.ETag || staging.ContentLength !== claimed.file.size || staging.ContentType !== claimed.file.type) throw validationError();
    await config.client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: candidate.key, CopySource: `${config.bucket}/${claimed.staging.key.split("/").map(encodeURIComponent).join("/")}`, CopySourceIfMatch: staging.ETag, MetadataDirective: "REPLACE", ContentType: claimed.file.type, ContentDisposition: "attachment", CacheControl: "private, no-store" }), { abortSignal: signal });
    const head = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: candidate.key }), { abortSignal: signal });
    if (!head.ETag || head.ContentLength !== claimed.file.size || head.ContentType !== claimed.file.type) throw validationError();
    const read = await config.client.send(new GetObjectCommand({ Bucket: config.bucket, Key: candidate.key, IfMatch: head.ETag }), { abortSignal: signal });
    if (!read.Body || read.ContentLength !== claimed.file.size) throw validationError();
    const hash = createHash("sha256"); let length = 0; let prefix = Buffer.alloc(0);
    for await (const chunk of read.Body.transformToWebStream()) {
      length += chunk.byteLength;
      if (length > claimed.file.size || length > filePolicy.bytes) throw validationError();
      hash.update(chunk);
      if (prefix.length < 512) prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 512 - prefix.length)]);
    }
    if (length !== claimed.file.size || hash.digest("hex") !== claimed.file.sha256 || !validSignature(claimed.file.type, prefix)) throw validationError();
    return await ctx.runMutation(internal.platform.fileRecords.complete, { ...args, generation: claimed.file.generation, candidateObjectId: candidate._id });
  } catch (error) {
    const invalid = error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === "VALIDATION";
    await ctx.runMutation(internal.platform.fileRecords.failed, { ...args, generation: claimed.file.generation, failure: invalid ? "VALIDATION" : "TEMPORARY" }).catch(() => null);
    if (error instanceof ConvexError) throw error;
    fail("TEMPORARY");
  } finally { config.client.destroy(); }
} });
export const download = action({ args: { ...fileScope, target: resourceTarget, preview: v.boolean() }, returns: v.object({ url: v.string(), expiresAt: v.number() }), handler: async (ctx, args) => {
  const info = await ctx.runQuery(internal.platform.fileRecords.downloadInfo, args);
  const config = storage(); const grant = expiry(filePolicy.downloadSeconds, config.expiration);
  if (args.preview && !["image/png", "image/jpeg", "image/webp"].includes(info.file.type)) fail("VALIDATION");
  const fallback = info.file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 100) || "download";
  const disposition = `${args.preview ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(info.file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  const url = await getSignedUrl(config.client, new GetObjectCommand({ Bucket: config.bucket, Key: info.object.key, ResponseContentDisposition: disposition, ResponseContentType: info.file.type, ResponseCacheControl: "private, no-store" }), { expiresIn: grant.seconds });
  const after = await ctx.runQuery(internal.platform.fileRecords.downloadInfo, args);
  if (after.object._id !== info.object._id) fail("CONFLICT");
  return { url, expiresAt: grant.at };
} });
export const reconcile = internalAction({ args: {}, returns: v.null(), handler: async (ctx) => {
  const config = storage();
  await ctx.runMutation(internal.platform.fileRecords.abandonReady, {});
  const objects = await ctx.runQuery(internal.platform.fileRecords.dueObjects, {});
  try {
    for (const candidate of objects) {
      const object = await ctx.runMutation(internal.platform.fileRecords.cleanupClaim, { objectId: candidate._id });
      if (!object) continue;
      let success = false;
      try { await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: object.key }), { abortSignal: AbortSignal.timeout(10000) }); success = true; } catch { /* The persisted cleanup row owns the retry. */ }
      await ctx.runMutation(internal.platform.fileRecords.cleaned, { objectId: object._id, success });
    }
  } finally { config.client.destroy(); }
  return null;
} });
