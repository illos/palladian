import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore, type Draft } from "../../src/cache";
import {
  FakeNote,
  draftOf,
  live,
  server,
  summary,
  type Handler,
} from "./fake-server";

interface Controller {
  openNotes: Set<string>;
  syncDrafts(): Promise<void>;
  setOpen(noteId: string, open: boolean): void;
  recheckAccess(accountId: string, ids: string[]): Promise<void>;
  recoverCreated(
    accountId: string,
    noteId: string,
    draft: Draft,
  ): Promise<void>;
}
const control = (store: NotesStore, handlers: Record<string, Handler>) =>
  live(store, handlers) as unknown as Controller;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** A conflict copy of "note" waiting to be created, with the source's summary cached. */
async function copyFixture(store: NotesStore, notebookId = "nb") {
  const fence = await store.captureFence("account");
  await store.cacheSummaries(
    "account",
    [
      {
        id: "note",
        title: "Plan",
        preview: "",
        updatedAt: 1,
        notebookId,
        role: "edit",
        trashed: false,
      },
    ],
    [],
    fence,
  );
  const draft = draftOf(markdownToDoc("Private local version"), {
    notebookId,
  });
  await store.writeDraft(draft);
  await store.splitConflict(
    draft,
    "local-copy",
    {
      accountId: "account",
      id: "note",
      document: JSON.stringify(markdownToDoc("Remote version").toJSON()),
      text: "Remote version",
      revision: 1,
    },
    fence,
  );
  const [copy] = await store.localDrafts("account");
  return copy!;
}

describe("recovery sends only the latest saved draft", () => {
  test("an older tab never overwrites newer recovered work", async () => {
    const name = "r6-" + crypto.randomUUID();
    const a = new NotesStore(name);
    const b = new NotesStore(name);
    try {
      const note = new FakeNote(markdownToDoc("Origin"));
      const old = draftOf(markdownToDoc("First draft"), {
        clientId: "shared-recovery",
      });
      await a.writeDraft(old);
      const handlers = server(note);
      const reading = gate();
      const release = gate();
      // Tab A, without the cross-tab lock, pauses before reading the note.
      const stale = control(a, {
        ...handlers,
        "notes:content": async (args) => {
          reading.open();
          await release.opened;
          return handlers["notes:content"]!(args);
        },
      }).recoverCreated("account", "note", old);
      await reading.opened;
      await b.writeDraft(
        draftOf(markdownToDoc("Newer work from tab B"), { updatedAt: 2 }),
      );
      await control(b, handlers).syncDrafts();
      expect(note.doc.textContent).toBe("Newer work from tab B");
      expect(await b.readDraft("account", "note")).toBeUndefined();
      release.open();
      await stale;
      expect(note.doc.textContent).toBe("Newer work from tab B");
      expect(note.pushes).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });

  test("one tab recovers a note at a time; the other retries later", async () => {
    const name = "r6-" + crypto.randomUUID();
    const a = new NotesStore(name);
    const b = new NotesStore(name);
    try {
      const note = new FakeNote(markdownToDoc("Origin"));
      await a.writeDraft(draftOf(markdownToDoc("First draft")));
      const handlers = server(note);
      const reading = gate();
      const release = gate();
      const first = control(a, {
        ...handlers,
        "notes:content": async (args) => {
          reading.open();
          await release.opened;
          return handlers["notes:content"]!(args);
        },
      }).syncDrafts();
      await reading.opened;
      await b.writeDraft(draftOf(markdownToDoc("Newer"), { updatedAt: 2 }));
      // Tab B finds the note being recovered and leaves it for later.
      await control(b, handlers).syncDrafts();
      expect(note.pushes).toEqual([]);
      release.open();
      await first;
      // Tab A's snapshot is no longer the saved draft, so it sent nothing.
      expect(note.pushes).toEqual([]);
      await control(b, handlers).syncDrafts();
      expect(note.doc.textContent).toBe("Newer");
      expect(await b.readDraft("account", "note")).toBeUndefined();
    } finally {
      a.close();
      b.close();
    }
  });

  test("a note opened while recovery records its client ID is not sent", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const note = new FakeNote(markdownToDoc("Origin"));
      await store.writeDraft(draftOf(markdownToDoc("Local")));
      const controller = control(store, server(note));
      const replace = store.replaceDraftIf.bind(store);
      store.replaceDraftIf = async (expected, next) => {
        const replaced = await replace(expected, next);
        controller.setOpen("note", true);
        return replaced;
      };
      await controller.syncDrafts();
      expect(note.pushes).toEqual([]);
      expect((await store.readDraft("account", "note"))!.text).toBe("Local");
    } finally {
      store.close();
    }
  });

  test("an accepted send is settled only after the note closes", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const note = new FakeNote(markdownToDoc("Origin"));
      await store.writeDraft(draftOf(markdownToDoc("Local")));
      const handlers = server(note);
      const controller = control(store, {
        ...handlers,
        "notes:push": (args) => {
          controller.openNotes.add("note");
          return handlers["notes:push"]!(args);
        },
      });
      await controller.syncDrafts();
      expect(note.doc.textContent).toBe("Local");
      expect(await store.readDraft("account", "note")).toBeDefined();
      controller.openNotes.delete("note");
      await controller.syncDrafts();
      expect(await store.readDraft("account", "note")).toBeUndefined();
      expect(note.pushes).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("settling keeps a different draft saved at the same time", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const note = new FakeNote(markdownToDoc("Origin"));
      const old = draftOf(markdownToDoc("First draft"));
      await store.writeDraft(old);
      let first = true;
      await control(store, {
        ...server(note),
        "notes:content": async () => {
          if (first) {
            first = false;
            await store.writeDraft(
              draftOf(markdownToDoc("Newer same-time content")),
            );
          }
          return { doc: old.document, revision: 1, role: "edit" };
        },
      }).syncDrafts();
      expect((await store.readDraft("account", "note"))!.text).toBe(
        "Newer same-time content",
      );
      expect((await store.exportDrafts("account"))[0]!.text).toBe(
        "Newer same-time content",
      );
    } finally {
      store.close();
    }
  });

  test("a draft with a server ID is never created again", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      // Saved by an editor that did not know the note had been created.
      await store.writeDraft({
        accountId: "account",
        id: "server-note",
        document: JSON.stringify(markdownToDoc("Typed").toJSON()),
        text: "Typed",
        updatedAt: 1,
      });
      expect(await store.localDrafts("account")).toEqual([]);
      expect(
        (await store.adoptedDrafts("account")).map((draft) => draft.id),
      ).toEqual(["server-note"]);
    } finally {
      store.close();
    }
  });
});

describe("feed revocation reaches open conflict copies", () => {
  test("removing the source closes its copy in this and other tabs", async () => {
    const name = "r6-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const copy = await copyFixture(store);
      const here: string[] = [];
      const there: string[] = [];
      const received = gate();
      store.subscribe((event) => here.push(...(event.revokedNotes ?? [])));
      other.subscribe((event) => {
        if (!event.revokedNotes) return;
        there.push(...event.revokedNotes);
        received.open();
      });
      await store.cacheSummaries(
        "account",
        [],
        ["note"],
        await store.captureFence("account"),
      );
      await received.opened;
      expect(here).toEqual(expect.arrayContaining(["note", copy.id]));
      expect(there).toEqual(expect.arrayContaining(["note", copy.id]));
      expect(await other.exportDrafts("account")).toEqual([]);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("work whose access is in doubt is held, not deleted", () => {
  test("a source moved to a still-visible notebook keeps its pending copy", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const copy = await copyFixture(store, "old-notebook");
      const held: string[] = [];
      store.subscribe((event) => held.push(...(event.heldNotes ?? [])));
      // The snapshot lists notebooks, not the notes in them; the cached row is old.
      const result = await store.reconcileAccess(
        "account",
        new Set(["new-notebook"]),
        new Set(),
        await store.captureFence("account"),
      );
      expect(result).toEqual({ revoked: [], held: ["note"] });
      expect(held).toEqual(expect.arrayContaining(["note", copy.id]));
      // Hidden while held: nothing readable, listed, exported or created.
      expect(await store.read("account", "note")).toBeUndefined();
      expect(await store.read("account", copy.id)).toBeUndefined();
      expect(await store.list("account")).toEqual([]);
      expect(await store.exportDrafts("account")).toEqual([]);
      expect(await store.localDrafts("account")).toEqual([]);
      // The server confirms access through the new notebook.
      const note = new FakeNote(markdownToDoc("Remote version"));
      await control(store, {
        ...server(note),
        "notes:verifyAccess": () => ({
          subject: "account",
          summary: { ...summary, notebookId: "new-notebook" },
        }),
      }).recheckAccess("account", ["note"]);
      expect(await store.localDrafts("account")).toEqual([copy]);
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Private local version"]);
      const rows = await store.list("account");
      expect(rows.find((row) => row.id === "note")!.notebookId).toBe(
        "new-notebook",
      );
    } finally {
      store.close();
    }
  });

  test("an unanswered check keeps work held until a later answer", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const copy = await copyFixture(store, "old-notebook");
      await store.reconcileAccess(
        "account",
        new Set(),
        new Set(),
        await store.captureFence("account"),
      );
      const note = new FakeNote(markdownToDoc("Remote version"));
      await control(store, {
        ...server(note),
        "notes:verifyAccess": () => {
          throw new Error("offline");
        },
      }).recheckAccess("account", ["note"]);
      expect([...(await store.heldMarkers("account")).keys()]).toEqual([
        "note",
      ]);
      // An answer for another account changes nothing either.
      note.accessible = false;
      await control(store, {
        ...server(note),
        "notes:verifyAccess": () => ({ subject: "other", summary: null }),
      }).recheckAccess("account", ["note"]);
      expect([...(await store.heldMarkers("account")).keys()]).toEqual([
        "note",
      ]);
      note.accessible = true;
      await control(store, server(note)).recheckAccess("account", ["note"]);
      expect(await store.localDrafts("account")).toEqual([copy]);
    } finally {
      store.close();
    }
  });

  test("a note without local work is removed at once", async () => {
    const store = new NotesStore("r6-" + crypto.randomUUID());
    try {
      const fence = await store.captureFence("account");
      await store.cacheSummaries(
        "account",
        [
          {
            id: "cached",
            title: "Cached",
            preview: "",
            updatedAt: 1,
            notebookId: "gone",
            role: "read",
            trashed: false,
          },
        ],
        [],
        fence,
      );
      const result = await store.reconcileAccess(
        "account",
        new Set(),
        new Set(),
        fence,
      );
      expect(result).toEqual({ revoked: ["cached"], held: [] });
    } finally {
      store.close();
    }
  });
});
