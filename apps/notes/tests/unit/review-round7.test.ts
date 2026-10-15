import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import Dexie from "dexie";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import {
  FakeNote,
  draftOf,
  live,
  pauseRecovery,
  server,
  summary,
  type Handler,
} from "./fake-server";

interface Controller {
  openNotes: Set<string>;
  syncDrafts(): Promise<void>;
  recheckAccess(accountId: string, ids: string[]): Promise<void>;
}
const control = (store: NotesStore, handlers: Record<string, Handler>) =>
  live(store, handlers) as unknown as Controller;
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
  bodies: { get: (...args: unknown[]) => Promise<unknown> };
};
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
describe("notes written offline are created", () => {
  test("drafts with local and bare UUID IDs are created; server IDs are not", async () => {
    const store = new NotesStore("r7-" + crypto.randomUUID());
    try {
      const uuid = crypto.randomUUID();
      for (const id of ["local-abc", uuid, "ks7server"])
        await store.writeDraft({
          accountId: "account",
          id,
          document: doc(id),
          text: id,
          updatedAt: 1,
        });
      const keys: unknown[] = [];
      await control(store, {
        ...server(new FakeNote(markdownToDoc("Origin"))),
        "notes:create": (args) => {
          keys.push(args.clientKey);
          return { noteId: "new-" + keys.length, revision: 0 };
        },
      }).syncDrafts();
      expect(keys.sort()).toEqual(["local-abc", uuid].sort());
    } finally {
      store.close();
    }
  });
});

describe("work another tab holds only in memory survives access checks", () => {
  test("a snapshot in one tab holds, never deletes, another tab's unsaved typing", async () => {
    const name = "r7-" + crypto.randomUUID();
    const a = new NotesStore(name);
    const b = new NotesStore(name);
    try {
      await a.cacheSummaries(
        "account",
        [row("old-notebook")],
        [],
        await a.captureFence("account"),
      );
      // Tab B's typing could not be saved: it exists only in B's memory.
      const put = dbOf(b).drafts.put;
      dbOf(b).drafts.put = async () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      await expect(
        b.writeDraft(
          draftOf(markdownToDoc("Unsaved typing"), {
            notebookId: "old-notebook",
          }),
        ),
      ).rejects.toThrow("quota");
      dbOf(b).drafts.put = put;
      const revoked: string[] = [];
      b.subscribe((event) => revoked.push(...(event.revokedNotes ?? [])));
      // Tab A sees neither the typing nor a saved draft for the note.
      expect(
        await a.reconcileAccess(
          "account",
          new Set(["new-notebook"]),
          new Set(),
          await a.captureFence("account"),
        ),
      ).toEqual(["note"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(revoked).toEqual([]);
      expect(await b.exportDrafts("account")).toEqual([]);
      // The server confirms access through the note's new notebook.
      await control(a, {
        ...server(new FakeNote(markdownToDoc("Plan"))),
        "notes:verifyAccess": () => ({
          subject: "account",
          summary: { ...summary, notebookId: "new-notebook" },
        }),
      }).recheckAccess("account", ["note"]);
      expect(
        (await b.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Unsaved typing"]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("reads apply fences recorded while they run", () => {
  test("a revocation or hold during a read returns nothing", async () => {
    for (const fence of ["revoke", "hold"] as const) {
      const name = "r7-" + crypto.randomUUID();
      const store = new NotesStore(name);
      const other = new NotesStore(name);
      try {
        await store.cacheSummaries(
          "account",
          [row("old-notebook")],
          [],
          await store.captureFence("account"),
        );
        await store.writeDraft(
          draftOf(markdownToDoc("Private"), { notebookId: "old-notebook" }),
        );
        await pauseRecovery(store, async () => {
          if (fence === "revoke") await other.revokeNotes("account", ["note"]);
          else
            await other.reconcileAccess(
              "account",
              new Set(),
              new Set(),
              await other.captureFence("account"),
            );
        });
        expect(await store.read("account", "note")).toBeUndefined();
      } finally {
        store.close();
        other.close();
      }
    }
  });
});

describe("conflict copies from before this change are hidden with their source", () => {
  test("upgrading adds the source to existing copy summaries", async () => {
    const name = "r7-" + crypto.randomUUID();
    // The previous schema, with a copy summary that does not name its source.
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      summaries: "[accountId+id], accountId",
      bodies: "[accountId+id], accountId",
      drafts: "[accountId+id], accountId",
      accounts: "accountId",
      privacy: "key",
    });
    legacy.version(2).stores({
      notebooks: "[accountId+id], accountId",
      cursors: "[accountId+key], accountId",
    });
    legacy.version(3).stores({ revoked: "[accountId+id], accountId" });
    await legacy.table("summaries").bulkPut([
      { ...row("old-notebook"), accountId: "account", kind: "cached" },
      {
        accountId: "account",
        id: "local-copy",
        title: "Private title",
        preview: "",
        updatedAt: 2,
        kind: "draft",
        notebookId: "old-notebook",
      },
    ]);
    await legacy.table("drafts").put({
      accountId: "account",
      id: "local-copy",
      document: doc("Private title"),
      text: "Private title",
      updatedAt: 2,
      notebookId: "old-notebook",
      source: "note",
    });
    legacy.close();
    const store = new NotesStore(name);
    try {
      expect(
        (await store.list("account")).map((summary) => summary.id).sort(),
      ).toEqual(["local-copy", "note"]);
      await store.reconcileAccess(
        "account",
        new Set(),
        new Set(),
        await store.captureFence("account"),
      );
      expect(await store.list("account")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("tabs read each other's saved drafts", () => {
  test("a newer draft saved in another tab is read and recovered", async () => {
    const name = "r7-" + crypto.randomUUID();
    const a = new NotesStore(name);
    const b = new NotesStore(name);
    try {
      await a.writeDraft(draftOf(markdownToDoc("Old A")));
      await b.writeDraft(draftOf(markdownToDoc("New B"), { updatedAt: 2 }));
      expect((await a.read("account", "note"))!.text).toBe("New B");
      const note = new FakeNote(markdownToDoc("Origin"));
      await control(a, server(note)).syncDrafts();
      expect(note.doc.textContent).toBe("New B");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("an open note is never settled underneath its editor", () => {
  test("opening while settlement starts keeps the draft", async () => {
    const store = new NotesStore("r7-" + crypto.randomUUID());
    try {
      const note = new FakeNote(markdownToDoc("Same"));
      await store.writeDraft(draftOf(markdownToDoc("Same")));
      const controller = control(store, server(note));
      const capture = store.captureFence.bind(store);
      store.captureFence = async (accountId) => {
        controller.openNotes.add("note");
        return capture(accountId);
      };
      await controller.syncDrafts();
      expect(await store.readDraft("account", "note")).toBeDefined();
    } finally {
      store.close();
    }
  });
});
