import { ConvexCallError, convexCaller, type ConvexCaller } from "./convex.ts";
import { fns, type ObjectMeta } from "./convex-api.ts";
import { mintServiceJwt } from "./jwt.ts";

/**
 * Attachment bytes (port plan B1). R2 is private; every byte leaves through
 * these routes after Convex (apps/notes-backend/convex/files.ts) says so.
 *
 *   PUT  /files/upload/<objectId>             Authorization: Bearer <upload ticket>
 *   GET  /files/notes/<noteId>/<objectId>     Authorization: Bearer <Convex token>
 *   GET  /files/public/<publicToken>/<objectId>
 *
 * Uploads: the ticket comes from `files.createUpload`. The Worker asks Convex
 * (as the file service) to admit the upload: it answers the expected size and
 * SHA-256 and grants a write lease. The Worker reads at most that many bytes,
 * checks both, writes `objects/<objectId>` only while the lease lasts
 * (deleting an object's bytes waits for its lease) and finalizes. A retry
 * with the same ticket writes the same key or finds the object ready, so it
 * never makes a second object.
 *
 * Reads: the app sends its own short-lived Convex token in the Authorization
 * header (never in the URL), and Convex decides with the caller's identity.
 * Only PNG, JPEG, GIF and WebP are served inline; everything else is an
 * octet-stream download. Every response carries nosniff, a sandboxing CSP and
 * `no-store`, so bytes never enter the browser's HTTP cache (D28: the app's
 * own cache is what sign-out clears).
 *
 * Never log tickets, tokens, URLs of these routes or file names.
 */

export const FILES_PREFIX = "/files/";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const ID = /^[a-z0-9]{16,64}$/;
const TICKET = /^[A-Za-z0-9_-]{20,200}$/;
const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const BEARER = /^Bearer ([^\s]{1,8192})$/;
const OBJECT_KEY = /^objects\/[a-z0-9]{16,64}$/;
/** Deletions handled per batch, and batches per scheduled run. */
const DELETION_BATCH = 100;
const DELETION_ROUNDS = 20;

export interface FilesEnv {
  FILES?: R2Bucket;
  CONVEX_URL: string;
  AGENT_JWT_PRIVATE_KEY: string;
  AGENT_JWT_ISSUER: string;
}

export interface FilesDeps {
  /** Convex as the file service; tests substitute a fake. */
  service?: (env: FilesEnv) => Promise<ConvexCaller>;
  /** Convex as the caller (their token) or signed out (null). */
  caller?: (env: FilesEnv, token: string | null) => ConvexCaller;
}

async function serviceConvex(env: FilesEnv): Promise<ConvexCaller> {
  const jwt = await mintServiceJwt({
    privateKey: env.AGENT_JWT_PRIVATE_KEY,
    issuer: env.AGENT_JWT_ISSUER,
  });
  return convexCaller(env.CONVEX_URL, { auth: jwt });
}

function callerConvex(env: FilesEnv, token: string | null): ConvexCaller {
  return convexCaller(env.CONVEX_URL, token ? { auth: token } : {});
}

export function objectKey(objectId: string): string {
  return `objects/${objectId}`;
}

function json(status: number, body: Record<string, unknown>, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}
const error = (status: number, code: string, extra = {}) =>
  json(status, { error: code }, extra);

function bearer(request: Request): string | null {
  return BEARER.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest))
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The whole body, or null as soon as it exceeds `max` bytes. */
async function readAtMost(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type StoreFailure =
  | "not_found"
  | "expired"
  | "size_mismatch"
  | "hash_mismatch"
  | "too_slow"
  | "unavailable";
export type StoreResult =
  | { ok: true; size: number; sha256: string }
  | { ok: false; error: StoreFailure };

const STORE_STATUS: Record<StoreFailure, number> = {
  not_found: 404,
  expired: 410,
  size_mismatch: 422,
  hash_mismatch: 422,
  too_slow: 408,
  unavailable: 503,
};

function logFailure(stage: string, failure: unknown) {
  // Categories only: never tickets, tokens, IDs or names.
  console.warn("File service call failed", {
    stage,
    kind: failure instanceof ConvexCallError ? failure.failure.kind : "error",
  });
}

/**
 * Accept the bytes for one upload ticket: check them against what Convex
 * expects, write R2, finalize. `read(max)` supplies the bytes, or null when
 * there are more than `max`. Safe to repeat with the same ticket.
 */
export async function storeObject(
  env: FilesEnv & { FILES: R2Bucket },
  objectId: string,
  ticket: string,
  read: (max: number) => Promise<Uint8Array | null>,
  deps: FilesDeps = {},
): Promise<StoreResult> {
  if (!ID.test(objectId) || !TICKET.test(ticket))
    return { ok: false, error: "not_found" };
  // A fresh short-lived service token for each call: reading a slow body can
  // outlast one (review F5).
  const service = () => (deps.service ?? serviceConvex)(env);
  let target;
  try {
    target = await (
      await service()
    ).mutation(fns.files.admitUpload, { objectId, ticket });
  } catch (failure) {
    logFailure("admit", failure);
    return { ok: false, error: "unavailable" };
  }
  if (target.status === "denied") return { ok: false, error: "not_found" };
  if (target.status === "gone") return { ok: false, error: "expired" };
  if (target.status === "ready")
    return { ok: true, size: target.size, sha256: target.sha256 };
  const bytes = await read(target.size);
  if (!bytes || bytes.byteLength !== target.size)
    return { ok: false, error: "size_mismatch" };
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== target.sha256) return { ok: false, error: "hash_mismatch" };
  // Write only within the lease Convex granted: once it has passed, the
  // object's bytes may already be queued for deletion (review F3).
  if (Date.now() >= target.leaseUntil) return { ok: false, error: "too_slow" };
  const key = objectKey(objectId);
  try {
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: target.mimeType },
      // R2 verifies the checksum again on its side.
      sha256,
    });
  } catch (failure) {
    logFailure("put", failure);
    return { ok: false, error: "unavailable" };
  }
  // The write may have completed after the lease (a slow R2 write, clock
  // differences): its object may have been cancelled and swept meanwhile.
  const late = Date.now() >= target.leaseUntil;
  const removeWrite = () =>
    env.FILES.delete(key).catch((failure: unknown) =>
      logFailure("cleanup", failure),
    );
  let done;
  try {
    done = await (
      await service()
    ).mutation(fns.files.finalize, {
      objectId,
      ticket,
      size: bytes.byteLength,
      sha256,
    });
  } catch (failure) {
    // Unknown outcome: the object may be ready (this finalize, or another
    // request's), so the bytes stay. If it fails instead, its deletion
    // tombstone removes them on a later sweep.
    logFailure("finalize", failure);
    return { ok: false, error: "unavailable" };
  }
  // Ready: these are its verified bytes, whoever finalized it, late or not.
  if (done.status === "ready") return { ok: true, size: target.size, sha256 };
  // The object will never be ready, or the write came after its lease:
  // remove what this request wrote.
  if (done.status === "gone" || late) await removeWrite();
  return done.status === "gone"
    ? { ok: false, error: "expired" }
    : { ok: false, error: "not_found" };
}

async function handleUpload(
  request: Request,
  env: FilesEnv & { FILES: R2Bucket },
  objectId: string,
  deps: FilesDeps,
): Promise<Response> {
  if (request.method !== "PUT")
    return error(405, "method_not_allowed", { Allow: "PUT" });
  const ticket = bearer(request);
  if (!ticket || !TICKET.test(ticket)) return error(401, "unauthenticated");
  const declared = request.headers.get("Content-Length");
  const length = declared === null ? null : Number(declared);
  if (length !== null && length > MAX_UPLOAD_BYTES)
    return error(413, "too_large");
  const result = await storeObject(
    env,
    objectId,
    ticket,
    async (max) =>
      length !== null && length !== max ? null : readAtMost(request.body, max),
    deps,
  );
  if (!result.ok)
    return error(
      STORE_STATUS[result.error],
      result.error,
      result.error === "unavailable" ? { "Retry-After": "5" } : {},
    );
  return json(200, {
    object_id: objectId,
    state: "ready",
    size: result.size,
    sha256: result.sha256,
  });
}

/** `filename*` per RFC 8187, with an ASCII fallback. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Headers for an object's bytes; only the four image types render inline. */
export function fileHeaders(meta: ObjectMeta, size: number): Headers {
  const inline = INLINE_TYPES.has(meta.mimeType);
  return new Headers({
    "Content-Type": inline ? meta.mimeType : "application/octet-stream",
    "Content-Disposition": disposition(
      inline ? "inline" : "attachment",
      meta.name,
    ),
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    ETag: `"${meta.sha256}"`,
  });
}

async function serve(
  request: Request,
  env: FilesEnv & { FILES: R2Bucket },
  objectId: string,
  meta: ObjectMeta,
): Promise<Response> {
  const key = objectKey(objectId);
  if (request.method === "HEAD") {
    const head = await env.FILES.head(key);
    if (!head) return missingBytes();
    return new Response(null, { headers: fileHeaders(meta, head.size) });
  }
  const object = await env.FILES.get(key);
  if (!object) return missingBytes();
  return new Response(object.body, { headers: fileHeaders(meta, object.size) });
}

function missingBytes() {
  // Convex says ready but R2 has nothing: report, never guess.
  console.error("File bytes missing for a ready object");
  return error(404, "not_found");
}

async function handleRead(
  request: Request,
  env: FilesEnv & { FILES: R2Bucket },
  noteId: string,
  objectId: string,
  deps: FilesDeps,
): Promise<Response> {
  const token = bearer(request);
  if (!token) return error(401, "unauthenticated");
  if (!ID.test(noteId) || !ID.test(objectId)) return error(404, "not_found");
  let decision;
  try {
    decision = await (deps.caller ?? callerConvex)(env, token).query(
      fns.files.authorizeRead,
      { noteId, objectId },
    );
  } catch (failure) {
    if (
      failure instanceof ConvexCallError &&
      failure.failure.kind === "rejected" &&
      failure.failure.credentials
    )
      return error(401, "unauthenticated");
    logFailure("read", failure);
    return error(503, "unavailable", { "Retry-After": "5" });
  }
  if (decision.access === "unauthenticated")
    return error(401, "unauthenticated");
  if (decision.access === "denied") return error(404, "not_found");
  return serve(request, env, objectId, decision);
}

async function handlePublic(
  request: Request,
  env: FilesEnv & { FILES: R2Bucket },
  token: string,
  objectId: string,
  deps: FilesDeps,
): Promise<Response> {
  if (!PUBLIC_TOKEN.test(token) || !ID.test(objectId))
    return error(404, "not_found");
  let meta;
  try {
    meta = await (deps.caller ?? callerConvex)(env, null).query(
      fns.files.authorizePublicRead,
      { token, objectId },
    );
  } catch (failure) {
    logFailure("public", failure);
    return error(503, "unavailable", { "Retry-After": "5" });
  }
  if (!meta) return error(404, "not_found");
  return serve(request, env, objectId, meta);
}

/** `/files/*`. Runs before the OAuth provider; it needs no OAuth state. */
export async function handleFiles(
  request: Request,
  env: FilesEnv,
  deps: FilesDeps = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const parts = pathname.slice(FILES_PREFIX.length).split("/");
  const files = env.FILES;
  if (!files) return error(503, "unavailable");
  const bound = { ...env, FILES: files };
  try {
    if (parts[0] === "upload" && parts.length === 2)
      return await handleUpload(request, bound, parts[1]!, deps);
    if (parts[0] !== "notes" && parts[0] !== "public")
      return error(404, "not_found");
    if (parts.length !== 3) return error(404, "not_found");
    if (request.method !== "GET" && request.method !== "HEAD")
      return error(405, "method_not_allowed", { Allow: "GET, HEAD" });
    return parts[0] === "notes"
      ? await handleRead(request, bound, parts[1]!, parts[2]!, deps)
      : await handlePublic(request, bound, parts[1]!, parts[2]!, deps);
  } catch (failure) {
    logFailure("route", failure);
    return error(500, "internal");
  }
}

/**
 * Delete the R2 bytes of permanently deleted and failed objects, as Convex
 * lists them; confirm each batch so it is not listed again. A failure leaves
 * the rest for the next run.
 */
export async function sweepDeletedFiles(
  env: FilesEnv,
  deps: FilesDeps = {},
): Promise<number> {
  const files = env.FILES;
  if (!files) return 0;
  // A fresh short-lived token for each call: a long sweep outlasts one.
  const service = () => (deps.service ?? serviceConvex)(env);
  let deleted = 0;
  for (let round = 0; round < DELETION_ROUNDS; round++) {
    const batch = await (
      await service()
    ).mutation(fns.files.deletionBatch, { limit: DELETION_BATCH });
    if (!batch.length) break;
    const keys = batch
      .map((row) => row.key)
      .filter((key) => OBJECT_KEY.test(key));
    if (keys.length) await files.delete(keys);
    await (
      await service()
    ).mutation(fns.files.confirmDeletions, {
      ids: batch.map((row) => row.id),
    });
    deleted += keys.length;
    if (batch.length < DELETION_BATCH) break;
  }
  return deleted;
}
