import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf } from "./fake-server";

type Db = {
  accounts: { put: (...args: unknown[]) => Promise<unknown> };
  drafts: {
    where: (index: string) => {
      equals: (value: string) => { delete: () => Promise<number> };
    };
  };
};
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
const activate = async (store: NotesStore) =>
  store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );
const draftCount = async (store: NotesStore) =>
  (await store.unsavedWork("account")).total;

describe("a recorded clear decides atomically against a newer sign-in", () => {
  test("finishing an old clear after the account signed in again deletes nothing", async () => {
    const name = "r13-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    try {
      await activate(first);
      await first.clearAccount("account");
      // Tab 1 signs in again and saves new work.
      await activate(first);
      await first.writeDraft(draftOf(markdownToDoc("New work")));
      // Tab 2's carried-over cleanup now finishes nothing.
      expect(await second.finishClear("account")).toBe(false);
      expect(await draftCount(first)).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  });

  test("a late clear message after a new sign-in leaves that tab signed in", async () => {
    const name = "r13-" + crypto.randomUUID();
    const store = new NotesStore(name);
    try {
      // Signed out (ending lifecycle 0), then signed in again: lifecycle 1.
      await activate(store);
      await store.clearAccount("account");
      await activate(store);
      const events: unknown[] = [];
      store.subscribe((event) => {
        if (event.invalidated) events.push(event);
      });
      // A clear message about the lifecycle before this sign-in arrives late.
      const late = new BroadcastChannel(name + ":invalidation");
      late.postMessage({ accountId: "account", lifecycle: 0 });
      late.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("a clear that failed still completes", () => {
  test("a block that could not be written is retried by this page", async () => {
    const store = new NotesStore("r13-" + crypto.randomUUID());
    try {
      await activate(store);
      await store.writeDraft(draftOf(markdownToDoc("Old work")));
      const put = dbOf(store).accounts.put;
      dbOf(store).accounts.put = async () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(store.clearAccount("account")).rejects.toThrow("quota");
      dbOf(store).accounts.put = put;
      expect(await store.clearAccount("account")).toBe(true);
      await activate(store);
      expect(await draftCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("an activation after a reload finishes a recorded clear before unblocking", async () => {
    const name = "r13-" + crypto.randomUUID();
    const store = new NotesStore(name);
    let reopened: NotesStore | undefined;
    try {
      await activate(store);
      await store.writeDraft(draftOf(markdownToDoc("Old work")));
      // The block commits but the deletion fails; then the page goes away.
      const drafts = dbOf(store).drafts;
      drafts.where = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(store.clearAccount("account")).rejects.toThrow();
      store.close();
      reopened = new NotesStore(name);
      await activate(reopened);
      expect(await draftCount(reopened)).toBe(0);
    } finally {
      store.close();
      reopened?.close();
    }
  });

  test("no tab can sign the account in while its clear is unresolved", async () => {
    const name = "r13-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    try {
      await activate(first);
      await first.writeDraft(draftOf(markdownToDoc("Old work")));
      const put = dbOf(first).accounts.put;
      dbOf(first).accounts.put = async () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(first.clearAccount("account")).rejects.toThrow("quota");
      // Another tab's sign-in waits for the clear rather than reviving its data.
      await expect(activate(second)).rejects.toThrow(/still clearing/);
      dbOf(first).accounts.put = put;
      expect(await first.clearAccount("account")).toBe(true);
      await activate(second);
      expect(await draftCount(second)).toBe(0);
    } finally {
      first.close();
      second.close();
    }
  });
});
