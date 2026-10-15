import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf } from "./fake-server";

type Table = Record<string, (...args: unknown[]) => unknown>;
const tableOf = (store: NotesStore, name: string) =>
  (store as unknown as { db: Record<string, Table> }).db[name]!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const activate = async (store: NotesStore) =>
  store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );

describe("a failed clear stays failed for everyone waiting on it", () => {
  test("a caller joining a failing background retry sees the failure", async () => {
    const store = new NotesStore("r16-" + crypto.randomUUID());
    try {
      await activate(store);
      await store.writeDraft(draftOf(markdownToDoc("Revoked work")));
      const accounts = tableOf(store, "accounts");
      const put = accounts.put!;
      // Every block write fails, slowly enough to join a running attempt.
      accounts.put = async () => {
        await sleep(500);
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(store.clearAccount("account", "revoked")).rejects.toThrow(
        "quota",
      );
      // The automatic retry starts after 2 s; join it while it runs.
      await sleep(2_100);
      await expect(store.clearAccount("account", "revoked")).rejects.toThrow(
        "quota",
      );
      // Nor can this tab sign the account in over its own unfinished clear.
      await expect(activate(store)).rejects.toThrow(/still being cleared/);
      accounts.put = put;
      expect(await store.clearAccount("account", "revoked")).toBe(true);
    } finally {
      store.close();
    }
  }, 10_000);
});

describe("unsaved typing from an ended lifecycle is never shown again", () => {
  test("typing kept through an old-version message is gone after the clear", async () => {
    const name = "r16-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await activate(store);
      const drafts = tableOf(store, "drafts");
      const put = drafts.put!;
      drafts.put = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(
        store.writeDraft(draftOf(markdownToDoc("Private typing"))),
      ).rejects.toThrow("quota");
      drafts.put = put;
      // An older tab clears the account, announcing it without a lifecycle.
      (other as unknown as { channel: null }).channel = null;
      await other.clearAccount("account");
      const hidden = new Promise<void>((resolve) =>
        store.subscribe((event) => {
          if (event.invalidated) resolve();
        }),
      );
      const legacy = new BroadcastChannel(name + ":invalidation");
      legacy.postMessage({ accountId: "account" });
      legacy.close();
      await hidden;
      // Signing in again begins a new lifecycle: the old typing stays ended.
      await activate(store);
      expect(await store.readDraft("account", "note")).toBeUndefined();
      expect(await store.exportDrafts("account")).toEqual([]);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("a finished decision cannot be replayed", () => {
  test("repeating a finished clear after signing in again changes nothing", async () => {
    const store = new NotesStore("r16-" + crypto.randomUUID());
    try {
      await activate(store);
      expect(await store.clearAccount("account", "logout")).toBe(true);
      await activate(store);
      await store.writeDraft(draftOf(markdownToDoc("New work")));
      expect(await store.clearAccount("account", "logout")).toBe(true);
      expect((await store.unsavedWork("account")).total).toBe(1);
    } finally {
      store.close();
    }
  });
});
