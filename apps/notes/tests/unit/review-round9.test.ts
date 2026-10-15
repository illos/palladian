import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

type Db = {
  drafts: { put: (...args: unknown[]) => Promise<unknown> };
  bodies: { count(): Promise<number> };
};
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
const row = (id: string, notebookId = "nb") => ({
  id,
  title: id,
  preview: "",
  updatedAt: 1,
  notebookId,
  role: "edit" as const,
  trashed: false,
});

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

describe("another account signing in keeps this account's unsaved work", () => {
  test("drafts, unsaved snapshots and fences survive; cached server text does not", async () => {
    const name = "r9-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const fence = await store.captureFence("account");
      await store.cacheSummaries(
        "account",
        [row("note", "gone"), row("cached")],
        [],
        fence,
      );
      await store.cacheAccepted(
        {
          accountId: "account",
          id: "cached",
          document: JSON.stringify(markdownToDoc("Server text").toJSON()),
          text: "Server text",
          revision: 0,
        },
        1,
        fence,
      );
      await store.writeDraft(
        draftOf(markdownToDoc("Saved draft"), { notebookId: "gone" }),
      );
      // Unsaved typing in this tab and in another tab, each only in memory.
      const restoreHere = fillStorage(store);
      await expect(
        store.writeDraft(
          draftOf(markdownToDoc("Unsaved here"), { id: "local-here" }),
        ),
      ).rejects.toThrow("quota");
      restoreHere();
      const restoreThere = fillStorage(other);
      await expect(
        other.writeDraft(
          draftOf(markdownToDoc("Unsaved there"), { id: "local-there" }),
        ),
      ).rejects.toThrow("quota");
      restoreThere();
      // The note with the saved draft is held: its notebook left the snapshot.
      await store.reconcileAccess(
        "account",
        new Set(["nb"]),
        new Set(),
        await store.captureFence("account"),
      );
      await store.retireAccount("account");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await store.list("account")).toEqual([]);
      expect(await dbOf(store).bodies.count()).toBe(0);
      // The account signs in again.
      await store.allowAccount(
        "account",
        await store.captureActivationFence(),
        () => true,
      );
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text).sort(),
      ).toEqual(["Unsaved here", "Unsaved there"]);
      expect(await store.unsavedWork("account")).toEqual({
        total: 3,
        held: 1,
      });
      expect([...(await store.heldMarkers("account")).keys()]).toEqual([
        "note",
      ]);
    } finally {
      store.close();
      other.close();
    }
  });
});
