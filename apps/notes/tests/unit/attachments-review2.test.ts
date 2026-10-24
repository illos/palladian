import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import {
  AttachmentCache,
  type CleanupIntents,
} from "../../src/attachment-cache";
import { followAttachmentCache } from "../../src/attachment-cache-lifecycle";
import {
  browserAccountHints,
  SessionController,
  type SessionCheck,
} from "../../src/session";

/**
 * Review round 2 of B3: R2-1 (cleanup intent kept when IndexedDB cannot
 * record it) and R2-3 (failed background clears raise no unhandled
 * rejection). Real AttachmentCache, SessionController and account hint over
 * fake IndexedDB and storage; failures injected into IndexedDB.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4a";
let count = 0;
const name = () => `attachments-review2-${++count}`;
const bytes = (n: number) =>
  new Blob([new Uint8Array(n)], { type: "image/png" });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The durable cleanup list, in memory here (localStorage in the app). */
function cleanupList(fail = { write: false }): CleanupIntents {
  let accounts: string[] = [];
  return {
    read: () => [...accounts],
    write: (next) => {
      if (fail.write) throw new DOMException("Injected", "QuotaExceededError");
      accounts = [...next];
    },
  };
}

/** A storage area for the account hint, shared like localStorage. */
function storageArea() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

/** Writes to the `accounts` store (the lifecycle marks) fail until restored. */
function failMarks() {
  const prototype = (
    globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }
  ).IDBObjectStore.prototype;
  const original = prototype.put;
  prototype.put = function (this: IDBObjectStore, ...args) {
    if (this.name === "accounts")
      throw new DOMException("Injected", "QuotaExceededError");
    return original.apply(this, args);
  };
  return () => {
    prototype.put = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** A page that owns a session, its cache following it (as the pages do). */
function page(
  cache: AttachmentCache,
  hints: ReturnType<typeof browserAccountHints>,
  first: SessionCheck,
) {
  let answer = first;
  const session = new SessionController({
    service: { check: async () => answer, signOut: async () => undefined },
    hints,
    clearAccount: async () => undefined,
    finishCleanup: async () => undefined,
    settleAccount: async () => true,
  });
  const stop = followAttachmentCache(session, {
    cache,
    hints,
    events: new EventTarget() as unknown as Window,
  });
  session.start();
  return {
    session,
    stop() {
      stop();
      session.stop();
    },
    async answer(next: SessionCheck) {
      answer = next;
      session.retry({ afterSignIn: true });
      await pause(20);
    },
  };
}

describe("R2-1: a clear whose mark cannot be written is not lost", () => {
  test("mark fails → revoked → the same account signs in → reload: unreadable, then cleared", async () => {
    const db = name();
    const list = cleanupList();
    const hints = browserAccountHints(storageArea());
    const cache = new AttachmentCache(db, undefined, list);
    const before = page(cache, hints, { kind: "ready", accountId: "ada" });
    await pause(20);
    await cache.store("ada", OBJECT, bytes(32), await cache.ticket("ada"));
    expect(await cache.objects("ada")).toEqual([OBJECT]);
    restore = failMarks();
    await before.answer({ kind: "revoked", accountId: "ada" });
    await before.answer({ kind: "ready", accountId: "ada" });
    // Signed in again: the session's own hint no longer names a clean-up.
    expect(hints.read()).toMatchObject({ accountId: "ada", signedOut: false });
    expect(await cache.read("ada", OBJECT)).toBeNull();
    // Reload before any retry could succeed.
    before.stop();
    cache.close();
    restore();
    restore = null;
    const reopened = new AttachmentCache(db, undefined, list);
    const after = page(reopened, hints, { kind: "ready", accountId: "ada" });
    await pause(20);
    expect(await reopened.read("ada", OBJECT)).toBeNull();
    await reopened.settled();
    expect(await reopened.objects("ada")).toEqual([]);
    // Cleared and verified: the account caches again.
    expect(list.read()).toEqual([]);
    await reopened.store("ada", OBJECT, bytes(8), await reopened.ticket("ada"));
    expect((await reopened.read("ada", OBJECT))?.size).toBe(8);
    after.stop();
    reopened.close();
  });

  test("if even the cleanup list cannot be written, the page stops using IndexedDB until the clear is verified", async () => {
    const fail = { write: false };
    const list = cleanupList(fail);
    const db = name();
    const cache = new AttachmentCache(db, undefined, list);
    await cache.retain("ada");
    await cache.store("ada", OBJECT, bytes(32));
    await cache.retain("bob");
    await cache.store("bob", OBJECT, bytes(16), await cache.ticket("bob"));
    fail.write = true;
    restore = failMarks();
    // Ada's clear can be recorded nowhere.
    void cache.forget("ada").catch(() => undefined);
    // Bob is shown: nothing is read from or written to IndexedDB.
    expect(await cache.read("bob", OBJECT)).toBeNull();
    await cache.store("bob", "other", bytes(4), await cache.ticket("bob"));
    expect(await cache.objects("bob")).toEqual([OBJECT]);
    // Storage recovers: the retried clear is verified and the page resumes.
    restore();
    restore = null;
    await pause(1_200);
    await cache.settled();
    expect(await cache.objects("ada")).toEqual([]);
    expect((await cache.read("bob", OBJECT))?.size).toBe(16);
    cache.close();
  });

  test("a database that cannot open never counts as a clear", async () => {
    const list = cleanupList();
    const cache = new AttachmentCache(name(), undefined, list);
    cache.close(); // a database that cannot be used
    await cache.retain("ada").catch(() => undefined);
    await cache.forget("ada").catch(() => undefined);
    await cache.settled();
    expect(list.read()).toEqual(["ada"]);
    expect(await cache.read("ada", OBJECT)).toBeNull();
  });
});

describe("R2-3: failing background clears raise no unhandled rejection", () => {
  test("repeated failures stay pending, are retried, and recover", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const list = cleanupList();
      const cache = new AttachmentCache(name(), undefined, list);
      await cache.retain("ada");
      await cache.store("ada", OBJECT, bytes(32));
      restore = failMarks();
      await cache.forget("ada").catch(() => undefined);
      // Two scheduled retries fail too (after 1 s and 2 s).
      await pause(3_300);
      expect(unhandled).toEqual([]);
      expect(await cache.read("ada", OBJECT)).toBeNull();
      expect(list.read()).toEqual(["ada"]);
      restore();
      restore = null;
      await pause(5_300);
      await cache.settled();
      expect(await cache.objects("ada")).toEqual([]);
      expect(list.read()).toEqual([]);
      cache.close();
      await pause(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  }, 20_000);
});
