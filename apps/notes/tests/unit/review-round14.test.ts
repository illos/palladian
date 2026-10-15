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

describe("an unresolved clear keeps every tab from signing the account in", () => {
  for (const [failure, table, method] of [
    ["the block cannot be read", "accounts", "get"],
    ["the block cannot be written", "accounts", "put"],
    ["the deletion fails after the block", "drafts", "where"],
  ] as const)
    test(`when ${failure}, the clear completes before any sign-in`, async () => {
      const name = "r14-" + crypto.randomUUID();
      const first = new NotesStore(name);
      const second = new NotesStore(name);
      try {
        await activate(first);
        await first.writeDraft(draftOf(markdownToDoc("Revoked work")));
        const restore = fail(first, table, method);
        await expect(first.clearAccount("account")).rejects.toThrow();
        restore();
        await expect(activate(second)).rejects.toThrow(/still clearing/);
        expect(await first.clearAccount("account")).toBe(true);
        await activate(second);
        expect(await kept(second)).toBe(0);
        // The next lifecycle's work is never touched by the finished clear.
        await second.writeDraft(draftOf(markdownToDoc("New work")));
        expect(await first.finishClear("account")).toBe(false);
        expect(await kept(second)).toBe(1);
      } finally {
        first.close();
        second.close();
      }
    });
});

describe("clear messages are checked against this tab's own lifecycle", () => {
  test("a late message keeps a newer lifecycle and its unsaved typing", async () => {
    const name = "r14-" + crypto.randomUUID();
    const store = new NotesStore(name);
    try {
      await activate(store);
      await store.clearAccount("account");
      await activate(store);
      // Unsaved typing in the new lifecycle, kept only in memory.
      const restore = fail(store, "drafts", "put");
      await expect(
        store.writeDraft(draftOf(markdownToDoc("Unsaved new typing"))),
      ).rejects.toThrow("quota");
      restore();
      const late = new BroadcastChannel(name + ":invalidation");
      late.postMessage({ accountId: "account", lifecycle: 0 });
      late.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Unsaved new typing"]);
    } finally {
      store.close();
    }
  });

  test("a current message hides the account without reading storage", async () => {
    const name = "r14-" + crypto.randomUUID();
    const store = new NotesStore(name);
    try {
      await activate(store);
      const hidden = new Promise<void>((resolve) =>
        store.subscribe((event) => {
          if (event.invalidated) resolve();
        }),
      );
      fail(store, "accounts", "get");
      const message = new BroadcastChannel(name + ":invalidation");
      message.postMessage({ accountId: "account", lifecycle: 0 });
      message.close();
      await hidden;
      expect(await store.list("account")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
