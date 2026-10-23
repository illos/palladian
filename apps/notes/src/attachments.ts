import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import { ConvexError } from "convex/values";
import type { LiveController } from "./live";

/**
 * Attachment bytes between the app and the Worker (plan 08 B3, on B1's
 * protocol). Uploads: `files.createUpload` gives an object ID and a ticket,
 * the bytes go to `PUT /files/upload/<objectId>` with the ticket, and the
 * Worker finalizes. Reads: `GET /files/notes/<noteId>/<objectId>` with the
 * app's own Convex token in the Authorization header; the Worker asks Convex
 * whether this person may read that object through that note.
 *
 * Tokens and tickets only ever travel in headers: never in a URL, the page or
 * a log. The page sees only `blob:` URLs of bytes it already holds, made with
 * a picture type the Worker serves inline or as a plain download.
 */

/** The upload limit (B1). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Distinct attachments one note may hold (backend `MAX_NOTE_OBJECTS`). */
export const MAX_NOTE_ATTACHMENTS = 200;
/** The picture types the Worker serves inline; these upload as images. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Server IDs: the Worker's own check on note and object IDs in paths. */
const ID = /^[a-z0-9]{16,64}$/;
/** How long an upload waits for the server to admit it before offering Retry. */
export const ADMISSION_WAIT_MS = 30_000;

export interface UploadGrant {
  objectId: string;
  state: "pending" | "ready" | "failed";
  /** Present only while pending; sent once, in a header. */
  ticket: string | null;
  /** The name and media type as the server cleaned them. */
  name: string;
  mimeType: string;
}

/** What the editor needs from the server for attachments. */
export interface AttachmentService {
  readonly accountId: string;
  /** How long an upload waits for `createUpload` (default ADMISSION_WAIT_MS). */
  readonly admissionWaitMs?: number;
  /** Signed in to the server for this account, and connected. */
  connected(): boolean;
  createUpload(args: {
    noteId: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    requestId: string;
  }): Promise<UploadGrant>;
  /**
   * Stop an upload no note uses (pending fails; ready and unused is
   * deleted).
   */
  cancelUpload(objectId: string): Promise<void>;
  /** This account's Convex token for `/files` reads; `refresh` asks for a new one. */
  token(refresh?: boolean): Promise<string | null>;
  /**
   * Follow the objects a note's current content references and the server
   * holds (`files.noteObjects`): their IDs, or null when unknown.
   */
  watchNoteObjects(
    noteId: string,
    changed: (objects: ReadonlySet<string> | null) => void,
  ): () => void;
}

/** The open note's attachments: whose they are, and how to reach the server. */
export interface AttachmentContext {
  accountId: string;
  /** The note's server ID; null until the server has created it. */
  noteId: string | null;
  /** Null while this account is not signed in to the server. */
  service: AttachmentService | null;
  /**
   * The session's generation: reads begun under another are discarded
   * (review round 1, F3).
   */
  generation: number;
}

/** Why bytes could not be had. */
export class AttachmentReadError extends Error {
  constructor(
    /**
     * `unavailable`: the server grants nothing for this reference or the
     * object is gone; `signed-out`: no usable token; `failed`: anything else.
     */
    readonly kind: "unavailable" | "signed-out" | "failed",
  ) {
    super("Attachment could not be read: " + kind);
    this.name = "AttachmentReadError";
  }
}

/** Why an upload stopped. `retryable` false: trying again cannot help. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The object is gone or its ticket expired: retry with a new request. */
    readonly restart = false,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** The bytes as the page may hold them: a picture type, or a plain download. */
export function displayType(mimeType: string) {
  return INLINE_IMAGE_TYPES.has(mimeType)
    ? mimeType
    : "application/octet-stream";
}

/** Bytes of an object through a note the caller can read. */
export async function readAttachment(
  service: AttachmentService,
  noteId: string,
  objectId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!ID.test(noteId) || !ID.test(objectId))
    throw new AttachmentReadError("unavailable");
  // An expired token gets 401: ask for a new one once (Deltos GOTCHA-0006).
  for (const refresh of [false, true]) {
    const token = await service.token(refresh).catch(() => null);
    if (!token) throw new AttachmentReadError("signed-out");
    let response: Response;
    try {
      response = await fetch(`/files/notes/${noteId}/${objectId}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AttachmentReadError("failed");
    }
    if (response.status === 401 && !refresh) continue;
    if (response.status === 401) throw new AttachmentReadError("signed-out");
    if (response.status === 404) throw new AttachmentReadError("unavailable");
    if (!response.ok) throw new AttachmentReadError("failed");
    const type = response.headers.get("Content-Type") ?? "";
    return new Blob([await response.arrayBuffer()], {
      type: displayType(type.split(";")[0]!.trim()),
    });
  }
  throw new AttachmentReadError("signed-out");
}

/** The SHA-256 of a file, in hex, as `files.createUpload` expects. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const PUT_FAILURES: Record<number, UploadError> = {
  403: new UploadError("Files are turned off on the server right now.", true),
  404: new UploadError(
    "The upload expired. Retry to send it again.",
    true,
    true,
  ),
  408: new UploadError(
    "The upload took too long. Retry to send it again.",
    true,
  ),
  410: new UploadError(
    "The upload expired. Retry to send it again.",
    true,
    true,
  ),
  413: new UploadError("Files can be at most 25 MB.", false),
  422: new UploadError(
    "The file changed while it was sent. Retry to send it again.",
    true,
  ),
};

/**
 * Send the bytes for an upload ticket. XMLHttpRequest, because only it
 * reports progress while a request body is sent. Rejects with an AbortError
 * when `signal` aborts.
 */
export function putAttachment(
  objectId: string,
  ticket: string,
  body: Blob,
  options: { progress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const { progress, signal } = options;
  return new Promise((resolve, reject) => {
    if (!ID.test(objectId))
      return reject(new UploadError("The upload could not start.", true, true));
    if (signal?.aborted)
      return reject(new DOMException("Upload cancelled", "AbortError"));
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const done = () => signal?.removeEventListener("abort", abort);
    request.open("PUT", `/files/upload/${objectId}`);
    request.setRequestHeader("Authorization", `Bearer ${ticket}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        progress?.(event.loaded / event.total);
    };
    request.onload = () => {
      done();
      if (request.status >= 200 && request.status < 300) {
        progress?.(1);
        resolve();
        return;
      }
      reject(
        PUT_FAILURES[request.status] ??
          new UploadError(
            "The upload failed. Check the connection and retry.",
            true,
          ),
      );
    };
    request.onerror = () => {
      done();
      reject(
        new UploadError(
          "The upload failed. Check the connection and retry.",
          true,
        ),
      );
    };
    request.onabort = () => {
      done();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    request.send(body);
  });
}

/** A server refusal as a message for the upload's widget. */
export function uploadRefusal(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string")
      return new UploadError(data.message, true);
  }
  return new UploadError(
    "The upload failed. Check the connection and retry.",
    true,
  );
}

/** The `sub` and `exp` claims of a JWT, read without verification. */
function claims(token: string): { sub?: unknown; exp?: unknown } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const value: unknown = JSON.parse(
      atob(part.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** The service for one signed-in account, over the live layer's client. */
export function liveAttachmentService(
  live: LiveController,
  accountId: string,
): AttachmentService {
  let kept: { value: string; expires: number } | null = null;
  let asking: Promise<string | null> | null = null;
  const signedIn = () => {
    const state = live.getState();
    return state.ready && state.accountId === accountId;
  };
  return {
    accountId,
    connected: () => signedIn() && live.getState().connected,
    // The admission is kept whole, however long it takes: an upload that
    // stopped waiting for it still owns its object (review round 1, F7).
    createUpload: (args) =>
      live.client.mutation(api.files.createUpload, {
        ...args,
        noteId: args.noteId as Id<"notes">,
      }),
    async cancelUpload(objectId) {
      if (!ID.test(objectId)) return;
      await live.client.mutation(api.files.cancelUpload, {
        objectId: objectId as Id<"objects">,
      });
    },
    token(refresh = false) {
      if (!signedIn()) return Promise.resolve(null);
      if (!refresh && kept && kept.expires - 60_000 > Date.now())
        return Promise.resolve(kept.value);
      asking ??= live.auth.convex
        .token({ fetchOptions: { throw: false } })
        .then((result) => {
          const value = result.data?.token ?? null;
          const read = value ? claims(value) : null;
          // Only a token for this account, while it is still signed in.
          if (!value || read?.sub !== accountId || !signedIn()) {
            kept = null;
            return null;
          }
          kept = {
            value,
            expires: typeof read.exp === "number" ? read.exp * 1000 : 0,
          };
          return value;
        })
        .catch(() => null)
        .finally(() => {
          asking = null;
        });
      return asking;
    },
    watchNoteObjects(noteId, changed) {
      if (!ID.test(noteId)) {
        changed(null);
        return () => undefined;
      }
      const watch = live.client.watchQuery(api.files.noteObjects, {
        noteId: noteId as Id<"notes">,
      });
      const read = () => {
        let value;
        try {
          value = watch.localQueryResult();
        } catch {
          value = undefined;
        }
        changed(
          value
            ? new Set(
                value
                  .filter((object) => object.state === "ready")
                  .map((object) => object.objectId as string),
              )
            : null,
        );
      };
      const stop = watch.onUpdate(read);
      read();
      return () => {
        stop();
        changed(null);
      };
    },
  };
}
