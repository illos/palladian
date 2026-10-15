import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

const doc = (markdown: string) =>
  JSON.stringify(markdownToDoc(markdown).toJSON());
const row = (notebookId: string) => ({
  id: "note",
  title: "Plan",
  preview: "",
  updatedAt: 1,
  notebookId,
  role: "edit" as const,
  trashed: false,
});
type Db = {
  drafts: { put: (...args: unknown[]) => Promise<unknown> };
  summaries: { put: (value: unknown) => Promise<unknown> };
};
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
const hold = async (store: NotesStore) =>
  store.reconcileAccess(
    "account",
    new Set(),
    new Set(),
    await store.captureFence("account"),
  );

/** A note with an unsent draft in a notebook the next snapshot omits. */
async function noteWithDraft(store: NotesStore) {
  await store.cacheSummaries(
    "account",
    [row("old-notebook")],
    [],
    await store.captureFence("account"),
  );
  await store.writeDraft(
    draftOf(markdownToDoc("Unsent work"), { notebookId: "old-notebook" }),
  );
}

describe("held work is kept through sign-out", () => {
  test("held drafts count as unsaved work but are not exportable", async () => {
    const store = new NotesStore("r8-" + crypto.randomUUID());
    try {
      await noteWithDraft(store);
      await hold(store);
      expect(await store.hasDrafts("account")).toBe(true);
      expect(await store.unsavedWork("account")).toEqual({
        total: 1,
        held: 1,
      });
      expect(await store.exportDrafts("account")).toEqual([]);
      // A confirmed denial removes it; then nothing is left to keep.
      await store.purgeHeld(
        "account",
        [
          {
            id: "note",
            marker: (await store.heldMarkers("account")).get("note")!,
          },
        ],
        await store.captureFence("account"),
      );
      expect(await store.hasDrafts("account")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("assembled results use the fences current when they finish", () => {
  for (const fence of ["revoke", "hold"] as const)
    test(`an export or list running during a ${fence} leaves the note out`, async () => {
      const name = "r8-" + crypto.randomUUID();
      const store = new NotesStore(name);
      const other = new NotesStore(name);
      try {
        await noteWithDraft(store);
        const apply = () =>
          fence === "revoke"
            ? other.revokeNotes("account", ["note"])
            : hold(other);
        await pauseRecovery(store, apply);
        expect(await store.exportDrafts("account")).toEqual([]);
        expect(await store.list("account")).toEqual([]);
      } finally {
        store.close();
        other.close();
      }
    });

  test("search results can be checked against fences", async () => {
    const store = new NotesStore("r8-" + crypto.randomUUID());
    try {
      await noteWithDraft(store);
      await store.revokeNotes("account", ["gone"]);
      await hold(store);
      expect(
        [
          ...(await store.fencedNotes("account", ["note", "gone", "open"])),
        ].sort(),
      ).toEqual(["gone", "note"]);
    } finally {
      store.close();
    }
  });
});

describe("late revocation messages from other tabs", () => {
  test("a message older than renewed access keeps newer unsaved work", async () => {
    const name = "r8-" + crypto.randomUUID();
    const store = new NotesStore(name);
    try {
      await store.revokeNotes("account", ["note"]);
      const marker = (await store.revocationMarkers("account", ["note"])).get(
        "note",
      )!;
      await store.allowNotes(
        "account",
        [{ id: "note", marker }],
        await store.captureFence("account"),
      );
      // New typing that could only be kept in memory.
      const put = dbOf(store).drafts.put;
      dbOf(store).drafts.put = async () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(
        store.writeDraft(draftOf(markdownToDoc("Newer typing"))),
      ).rejects.toThrow("quota");
      dbOf(store).drafts.put = put;
      const events: string[] = [];
      store.subscribe((event) => events.push(...(event.revokedNotes ?? [])));
      // The revocation message from another tab arrives only now.
      const late = new BroadcastChannel(name + ":invalidation");
      late.postMessage({ accountId: "account", revokedNotes: ["note"] });
      late.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]);
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Newer typing"]);
    } finally {
      store.close();
    }
  });

  test("a current revocation message still removes unsaved work", async () => {
    const name = "r8-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const put = dbOf(store).drafts.put;
      dbOf(store).drafts.put = async () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(
        store.writeDraft(draftOf(markdownToDoc("Typing"))),
      ).rejects.toThrow("quota");
      dbOf(store).drafts.put = put;
      const received = new Promise<string[]>((resolve) =>
        store.subscribe((event) => {
          if (event.revokedNotes) resolve(event.revokedNotes);
        }),
      );
      await other.revokeNotes("account", ["note"]);
      expect(await received).toEqual(["note"]);
      expect(await store.exportDrafts("account")).toEqual([]);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("copies written by an older version", () => {
  test("a copy summary without its source is hidden with the source", async () => {
    const store = new NotesStore("r8-" + crypto.randomUUID());
    try {
      await store.cacheSummaries(
        "account",
        [row("old-notebook")],
        [],
        await store.captureFence("account"),
      );
      // An older tab wrote the copy: its draft names the source, its summary does not.
      await dbOf(store).drafts.put({
        accountId: "account",
        id: "local-copy",
        document: doc("Private title"),
        text: "Private title",
        updatedAt: 2,
        notebookId: "old-notebook",
        source: "note",
      });
      await dbOf(store).summaries.put({
        accountId: "account",
        id: "local-copy",
        title: "Private title",
        preview: "",
        updatedAt: 2,
        kind: "draft",
        notebookId: "old-notebook",
      });
      await hold(store);
      expect(await store.list("account")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
