import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf } from "./fake-server";

type Table = Record<string, (...args: unknown[]) => unknown>;
const tableOf = (store: NotesStore, name: string) =>
  (store as unknown as { db: Record<string, Table> }).db[name]!;
const activate = async (store: NotesStore) =>
  store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );

describe("unsaved typing from an ended epoch never steers later writes", () => {
  test("a tab signing in after another lifted the block drops its old typing", async () => {
    const name = "r17-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    const older = new NotesStore(name);
    try {
      await activate(second);
      // Tab B's typing could only be kept in memory.
      const drafts = tableOf(second, "drafts");
      const put = drafts.put!;
      drafts.put = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(
        second.writeDraft(
          draftOf(markdownToDoc("Old typing"), {
            notebookId: "old-notebook",
            clientId: "old-client",
          }),
        ),
      ).rejects.toThrow("quota");
      drafts.put = put;
      // An older-version tab clears the account without naming the lifecycle.
      (older as unknown as { channel: null }).channel = null;
      await older.clearAccount("account");
      const hidden = new Promise<void>((resolve) =>
        second.subscribe((event) => {
          if (event.invalidated) resolve();
        }),
      );
      const legacy = new BroadcastChannel(name + ":invalidation");
      legacy.postMessage({ accountId: "account" });
      legacy.close();
      await hidden;
      // Tab A signs in first, lifting the block; then tab B signs in.
      await activate(first);
      const current = draftOf(markdownToDoc("Current draft"), { updatedAt: 5 });
      await first.writeDraft(current);
      await activate(second);
      // B's compare-and-replace accepts the current draft.
      const next = { ...current, updatedAt: 6 };
      expect(await second.replaceDraftIf(current, next)).toBe(true);
      // B's content-only save of that note takes no sync state from the
      // ended typing.
      await second.writeDraft({
        accountId: "account",
        id: "note",
        document: current.document,
        text: "Content only",
        updatedAt: 7,
      });
      const saved = (await second.readDraft("account", "note"))!;
      expect(saved.clientId).not.toBe("old-client");
      expect(saved.notebookId).not.toBe("old-notebook");
    } finally {
      first.close();
      second.close();
      older.close();
    }
  });
});
