import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

type Db = { drafts: { put: (...args: unknown[]) => Promise<unknown> } };
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
/** Make the next draft writes of `store` fail as if storage were full. */
function fillStorage(store: NotesStore) {
  const put = dbOf(store).drafts.put;
  dbOf(store).drafts.put = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  return () => {
    dbOf(store).drafts.put = put;
  };
}
describe("a saved snapshot is never revived over newer work", () => {
  for (const reader of ["read", "list", "export"] as const)
    test(`${reader} started before the save shows the newer stored draft`, async () => {
      const name = "r9-" + crypto.randomUUID();
      const store = new NotesStore(name);
      const other = new NotesStore(name);
      try {
        const first = draftOf(markdownToDoc("Old unsaved"));
        const restore = fillStorage(store);
        await expect(store.writeDraft(first)).rejects.toThrow("quota");
        restore();
        await pauseRecovery(store, async () => {
          // The retry saves the snapshot; another tab then saves newer text.
          await store.writeDraft(first);
          await other.writeDraft(
            draftOf(markdownToDoc("Newer saved"), { updatedAt: 2 }),
          );
        });
        const text =
          reader === "read"
            ? (await store.read("account", "note"))!.text
            : reader === "list"
              ? (await store.list("account"))[0]!.title
              : (await store.exportDrafts("account"))[0]!.text;
        expect(text).toBe("Newer saved");
      } finally {
        store.close();
        other.close();
      }
    });
});
