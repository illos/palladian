import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf } from "./fake-server";

type Table = Record<string, (...args: unknown[]) => unknown>;
const tableOf = (store: NotesStore, name: string) =>
  (store as unknown as { db: Record<string, Table> }).db[name]!;
/** Make `method` of a table fail as if storage were full, until restored. */
function fail(store: NotesStore, name: string, method: string) {
  const table = tableOf(store, name);
  const original = table[method]!;
  table[method] = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  return () => {
    table[method] = original;
  };
}
const activate = async (store: NotesStore) =>
  store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );
const kept = async (store: NotesStore) =>
  (await store.unsavedWork("account")).total;

describe("a clear decision is finished once, for one lifecycle", () => {
  test("a tab that never knew the account cannot clear a later lifecycle by retrying", async () => {
    const name = "r15-" + crypto.randomUUID();
    // Tab A opens before the account exists on this device.
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    try {
      await activate(second);
      await second.writeDraft(draftOf(markdownToDoc("Old work")));
      // A learns of revocation; its block write fails, then a retry succeeds.
      const restore = fail(first, "accounts", "put");
      await expect(first.clearAccount("account", "revoked")).rejects.toThrow();
      restore();
      expect(await first.clearAccount("account", "revoked")).toBe(true);
      // B signs in again and saves new work.
      await activate(second);
      await second.writeDraft(draftOf(markdownToDoc("New work")));
      // A's session retries the same, finished decision.
      expect(await first.clearAccount("account", "revoked")).toBe(true);
      expect(await kept(second)).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  });

  test("overlapping attempts join, and no leftover retry outlives the clear", async () => {
    const name = "r15-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    try {
      await activate(first);
      const restore = fail(first, "drafts", "where");
      await expect(first.clearAccount("account", "revoked")).rejects.toThrow();
      restore();
      // The session's retry and another overlap; both finish the one clear.
      const results = await Promise.all([
        first.clearAccount("account", "revoked"),
        first.clearAccount("account", "revoked"),
      ]);
      expect(results).toEqual([true, true]);
      await activate(second);
      await second.writeDraft(draftOf(markdownToDoc("New work")));
      // Past the first scheduled retry: nothing was left to fire.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await kept(second)).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  }, 10_000);
});

describe("a message from an older version keeps unsaved typing", () => {
  test("an unnumbered clear message hides the account but keeps its typing", async () => {
    const name = "r15-" + crypto.randomUUID();
    const store = new NotesStore(name);
    try {
      await activate(store);
      await store.clearAccount("account");
      await activate(store);
      const restore = fail(store, "drafts", "put");
      await expect(
        store.writeDraft(draftOf(markdownToDoc("Unsaved new typing"))),
      ).rejects.toThrow("quota");
      restore();
      const hidden = new Promise<void>((resolve) =>
        store.subscribe((event) => {
          if (event.invalidated) resolve();
        }),
      );
      const legacy = new BroadcastChannel(name + ":invalidation");
      legacy.postMessage({ accountId: "account" });
      legacy.close();
      await hidden;
      expect(await store.list("account")).toEqual([]);
      // Signing in to this lifecycle again shows the typing.
      await activate(store);
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Unsaved new typing"]);
    } finally {
      store.close();
    }
  });
});

describe("closing a store gives up its place in line", () => {
  test("a clear queued behind another tab's lock is dropped on close", async () => {
    const name = "r15-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    const third = new NotesStore(name);
    try {
      await activate(first);
      const restore = fail(first, "accounts", "put");
      await expect(first.clearAccount("account")).rejects.toThrow();
      restore();
      // Tab B queues its own clear behind A's lock, then closes.
      const queued = second.clearAccount("account").catch(() => "closed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      second.close();
      expect(await first.clearAccount("account")).toBe(true);
      expect(await queued).toBe("closed");
      // Nothing holds the lock any more: another tab can sign in.
      await activate(third);
    } finally {
      first.close();
      third.close();
    }
  });
});
