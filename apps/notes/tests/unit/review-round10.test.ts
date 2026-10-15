import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

type Db = { drafts: { put: (...args: unknown[]) => Promise<unknown> } };
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
/** Make draft writes fail as if storage were full, until restored. */
function fill(store: NotesStore) {
  const target = dbOf(store).drafts;
  const put = target.put;
  target.put = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  return () => {
    target.put = put;
  };
}
/** Unsaved typing this store could keep only in memory. */
async function unsaved(store: NotesStore, text: string, id = "local-a") {
  const restore = fill(store);
  await expect(
    store.writeDraft(draftOf(markdownToDoc(text), { id })),
  ).rejects.toThrow("quota");
  restore();
}

describe("sign-out settlement is read at one point", () => {
  test("a hold during the read is reflected in both the export and the held count", async () => {
    const name = "r10-" + crypto.randomUUID();
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
      await store.writeDraft(
        draftOf(markdownToDoc("Work"), { notebookId: "gone" }),
      );
      await pauseRecovery(store, async () =>
        other.reconcileAccess(
          "account",
          new Set(),
          new Set(),
          await other.captureFence("account"),
        ),
      );
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

describe("the library shows the newest version", () => {
  test("a newer stored draft wins over an older unsaved snapshot", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await unsaved(store, "Older title");
      await other.writeDraft(
        draftOf(markdownToDoc("Newer title"), { id: "local-a", updatedAt: 2 }),
      );
      expect((await store.list("account"))[0]!.title).toBe("Newer title");
    } finally {
      store.close();
      other.close();
    }
  });
});
