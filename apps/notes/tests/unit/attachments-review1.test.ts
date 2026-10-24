import "fake-indexeddb/auto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AttachmentCache,
  type CleanupIntents,
} from "../../src/attachment-cache";
import { liveAttachmentService } from "../../src/attachments";
import type { LiveController } from "../../src/live";

/**
 * Review round 1 of B3: regression tests for F2 (clears that fail or are
 * cut short) and F7 (an admission answered after the upload stopped
 * waiting). F1 is in attachments-lifecycle.test.ts. Real AttachmentCache
 * over fake IndexedDB.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4a";
let count = 0;
const name = () => `attachments-review1-${++count}`;
const bytes = (n: number) =>
  new Blob([new Uint8Array(n)], { type: "image/png" });

/** The durable cleanup list, in memory here (localStorage in the app). */
function cleanupList(): CleanupIntents {
  let accounts: string[] = [];
  return {
    read: () => [...accounts],
    write: (next) => {
      accounts = [...next];
    },
  };
}

/** Make the next deletion from the `bytes` store fail, once. */
function failNextBytesDelete() {
  const prototype = (
    globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }
  ).IDBObjectStore.prototype;
  const original = prototype.delete;
  prototype.delete = function (this: IDBObjectStore, query) {
    if (this.name === "bytes") {
      prototype.delete = original;
      throw new DOMException("Injected failure", "UnknownError");
    }
    return original.call(this, query);
  };
  return () => {
    prototype.delete = original;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("F2: clears that fail or are cut short leave nothing readable", () => {
  test("a clear interrupted between deletions: after reopening, the bytes are unreadable and then gone", async () => {
    const db = name();
    const list = cleanupList();
    const first = new AttachmentCache(db, undefined, list);
    await first.retain("ada");
    await first.store("ada", OBJECT, bytes(32));
    const restore = failNextBytesDelete();
    await first.forget("ada").catch(() => undefined);
    restore();
    // The page closes before any retry.
    first.close();
    const reopened = new AttachmentCache(db, undefined, list);
    await reopened.retain("ada");
    expect(await reopened.read("ada", OBJECT)).toBeNull();
    await reopened.settled();
    expect(await reopened.objects("ada")).toEqual([]);
    expect(await reopened.size()).toBe(0);
    reopened.close();
  });

  test("a failed clear stays pending, refuses reads and is retried", async () => {
    const cache = new AttachmentCache(name(), undefined, cleanupList());
    await cache.retain("ada");
    await cache.store("ada", OBJECT, bytes(32));
    const restore = failNextBytesDelete();
    await expect(cache.forget("ada")).rejects.toBeTruthy();
    restore();
    // Signed in again before the retry: still nothing readable.
    expect(await cache.read("ada", OBJECT)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await cache.settled();
    expect(await cache.objects("ada")).toEqual([]);
    // Once cleared, the account caches again.
    await cache.store("ada", OBJECT, bytes(8), await cache.ticket("ada"));
    expect((await cache.read("ada", OBJECT))?.size).toBe(8);
    cache.close();
  });

  test("a write from another tab that has not heard of a clear stores nothing", async () => {
    const db = name();
    // Two tabs share the database and the cleanup list.
    const list = cleanupList();
    const here = new AttachmentCache(db, undefined, list);
    const there = new AttachmentCache(db, undefined, list);
    await here.retain("ada");
    await there.retain("ada");
    await here.forget("ada");
    // The other tab still shows Ada; its fetch began before the clear.
    await there.store("ada", OBJECT, bytes(16));
    expect(await here.objects("ada")).toEqual([]);
    expect(await there.read("ada", OBJECT)).toBeNull();
    here.close();
    there.close();
  });
});

describe("F7: an admission that answers after the upload stopped waiting", () => {
  test("the live service hands back the admission, however long it takes", async () => {
    vi.useFakeTimers();
    let answer!: (grant: unknown) => void;
    const live = {
      getState: () => ({ ready: true, accountId: "ada", connected: true }),
      client: {
        mutation: () => new Promise((resolve) => (answer = resolve)),
      },
      auth: {},
    } as unknown as LiveController;
    const service = liveAttachmentService(live, "ada");
    const admission = service.createUpload({
      noteId: "k1700000000000000000000000000note",
      name: "photo.png",
      mimeType: "image/png",
      size: 1,
      sha256: "0".repeat(64),
      requestId: "upload-review1",
    });
    const settled = vi.fn();
    admission.then(settled, settled);
    await vi.advanceTimersByTimeAsync(31_000);
    answer({
      objectId: OBJECT,
      state: "pending",
      ticket: "t",
      name: "photo.png",
      mimeType: "image/png",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: OBJECT }),
    );
  });
});
