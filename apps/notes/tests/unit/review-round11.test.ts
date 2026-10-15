import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

type Db = { drafts: { put: (...args: unknown[]) => Promise<unknown> } };
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
/** Unsaved typing this store could keep only in memory. */
async function unsaved(store: NotesStore, text: string, updatedAt: number) {
  const target = dbOf(store).drafts;
  const put = target.put;
  target.put = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  await expect(
    store.writeDraft(
      draftOf(markdownToDoc(text), { notebookId: "gone", updatedAt }),
    ),
  ).rejects.toThrow("quota");
  target.put = put;
}

describe("settlement counts unsaved work that changes while it reads", () => {
  test("a replacement snapshot and a hold during the read are both counted", async () => {
    const name = "r11-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await store.cacheSummaries(
        "account",
        [
          {
            id: "note",
            title: "Plan",
            preview: "",
            updatedAt: 1,
            notebookId: "gone",
            role: "edit",
            trashed: false,
          },
        ],
        [],
        await store.captureFence("account"),
      );
      await unsaved(store, "First typing", 1);
      await pauseRecovery(store, async () => {
        // Newer typing replaces the captured snapshot; then the note is held.
        await unsaved(store, "Replacement typing", 2);
        await other.reconcileAccess(
          "account",
          new Set(),
          new Set(),
          await other.captureFence("account"),
        );
      });
      expect(await store.settlement("account")).toEqual({
        drafts: [],
        total: 1,
        held: 1,
      });
    } finally {
      store.close();
      other.close();
    }
  });
});
