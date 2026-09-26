import type { UploadDriver } from "../../../../packages/ui/src/Uploader";

export interface UploadGrant {
  readonly url: string;
  readonly expiresAt: number;
  readonly headers: {
    readonly "Content-Type": string;
    readonly "If-None-Match": string;
  };
}
/** Signed URLs stay in this request closure; never include them in an error. */
export function putFile(
  file: File,
  grant: UploadGrant,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
      request.ontimeout = null;
      request.upload.onprogress = null;
      if (error) reject(error);
      else resolve();
    };
    request.open("PUT", grant.url);
    // The browser supplies Content-Length from the File body. Setting that
    // forbidden header manually would not prove that the signed length matches.
    request.setRequestHeader("Content-Type", grant.headers["Content-Type"]);
    request.setRequestHeader("If-None-Match", grant.headers["If-None-Match"]);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    };
    request.onload = () => {
      // A lost successful PUT response can make a retry return 412. Only the
      // subsequent server finalization may decide whether the existing bytes fit.
      if (
        (request.status >= 200 && request.status < 300) ||
        request.status === 412
      )
        finish();
      else finish(new Error("Upload was not confirmed"));
    };
    request.onerror = () => finish(new Error("Upload connection unavailable"));
    request.ontimeout = () =>
      finish(new Error("Upload connection unavailable"));
    request.onabort = () =>
      finish(new DOMException("Upload cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}
export function uploadDriver<Id extends string>(operations: {
  request(input: {
    name: string;
    type: string;
    size: number;
    sha256: string;
    idempotencyKey: string;
  }): Promise<{ file: { id: Id; state: string }; upload: UploadGrant | null }>;
  finalize(id: Id): Promise<{ state: string }>;
  cancel(id: Id): Promise<unknown>;
}): UploadDriver {
  return {
    async upload({ file, idempotencyKey, signal, progress }) {
      let fileId: Id | undefined;
      const check = () => {
        if (signal.aborted)
          throw new DOMException("Upload cancelled", "AbortError");
      };
      try {
        check();
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        check();
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const prepared = await operations.request({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          sha256,
          idempotencyKey,
        });
        fileId = prepared.file.id;
        check();
        if (prepared.file.state !== "ready") {
          if (prepared.upload)
            await putFile(file, prepared.upload, signal, progress);
          check();
          progress(1);
          const confirmed = await operations.finalize(fileId);
          check();
          if (confirmed.state !== "ready")
            throw new Error("File verification was not confirmed");
        }
        progress(1);
      } catch (error) {
        if (signal.aborted && fileId !== undefined) {
          // If logout already closed the old scoped client, reconciliation owns
          // remaining cleanup. Never switch to a newer account to cancel old work.
          void operations.cancel(fileId).catch(() => {
            /* Pending cleanup remains server-owned. */
          });
        }
        throw error;
      }
    },
  };
}
