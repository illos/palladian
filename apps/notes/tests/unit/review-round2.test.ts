import "fake-indexeddb/auto";
import { markdownToDoc, notesSchema } from "@palladian/notes-core";
import { getFunctionName } from "convex/server";
import { collab, receiveTransaction } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import { describe, expect, test } from "vitest";
import { NotesStore, type Draft } from "../../src/cache";
import { LiveController } from "../../src/live";

const json = (markdown: string) =>
  JSON.stringify(markdownToDoc(markdown).toJSON());
const row = {
  id: "note",
  title: "private",
  preview: "",
  updatedAt: 1,
  notebookId: "nb",
  role: "edit" as const,
  trashed: false,
};
const body = {
  accountId: "account",
  id: "note",
  document: json("private"),
  text: "private",
  revision: 0,
};

type Handler = (args: Record<string, unknown>) => unknown;
/** A LiveController with a fake Convex client dispatching by function name. */
function live(store: NotesStore, handlers: Record<string, Handler>) {
  const instance = Object.create(LiveController.prototype) as LiveController;
  const call = async (fn: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(fn as never);
    const handler = handlers[name];
    if (!handler) throw new Error("unexpected call " + name);
    return handler(args);
  };
  Object.assign(instance, {
    store,
    client: { query: call, mutation: call },
    state: {
      accountId: "account",
      ready: true,
      profile: null,
      connected: true,
    },
    openNotes: new Set(),
    syncingDrafts: false,
    fetchQueue: new Map(),
    fetching: 0,
    listeners: new Set(),
  });
  return instance as unknown as {
    syncDrafts(): Promise<void>;
    reconcileCreated(
      accountId: string,
      noteId: string,
      draft: Draft,
    ): Promise<void>;
    applyAccess(accountId: string, snapshot: unknown): Promise<void>;
  };
}

describe("revocation fences", () => {
  test("a delayed summary cannot lift a fence; only a later access check can", async () => {
    const store = new NotesStore("r2-" + crypto.randomUUID());
    try {
      const fence = await store.captureFence("account");
      await store.cacheSummaries("account", [row], [], fence);
      await store.cacheAccepted(body, 1, fence);
      const before = Date.now() - 1000;
      await store.revokeNotes("account", ["note"]);
      expect(await store.cacheSummaries("account", [row], [], fence)).toEqual([
        "note",
      ]);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      expect(await store.read("account", "note")).toBeUndefined();
      await store.allowNotes("account", ["note"], before);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      await store.allowNotes("account", ["note"], Date.now() + 1);
      expect(await store.cacheSummaries("account", [row], [], fence)).toEqual(
        [],
      );
      await store.cacheAccepted(body, 1, fence);
      expect((await store.read("account", "note"))!.text).toBe("private");
    } finally {
      store.close();
    }
  });

  test("a truncated access snapshot never revokes cached work", async () => {
    const store = new NotesStore("r2-" + crypto.randomUUID());
    try {
      const fence = await store.captureFence("account");
      await store.cacheSummaries("account", [row], [], fence);
      await store.writeDraft({ ...body, updatedAt: 2, baseRevision: 0 });
      const controller = live(store, { "notes:content": () => null });
      Object.assign(controller, { feeds: new Map(), visibleNotebooks: null });
      await controller.applyAccess("account", {
        notebooks: [],
        shared: [],
        complete: false,
      });
      expect(await store.read("account", "note")).toBeDefined();
      expect((await store.exportDrafts("account")).map((d) => d.id)).toEqual([
        "note",
      ]);
    } finally {
      store.close();
    }
  });
});

describe("creation recovery", () => {
  test("a failure after adoption never creates the note a second time", async () => {
    const store = new NotesStore("r2-" + crypto.randomUUID());
    try {
      await store.writeDraft({ ...body, id: "local-first", updatedAt: 1 });
      const keys: unknown[] = [];
      const controller = live(store, {
        "notes:create": (args) => {
          keys.push(args.clientKey);
          return { noteId: "server-1", revision: 0, replayed: keys.length > 1 };
        },
        "history:read": () => {
          throw new Error("offline");
        },
        "notes:content": () => {
          throw new Error("offline");
        },
      });
      await controller.syncDrafts();
      await controller.syncDrafts();
      expect(keys).toEqual(["local-first"]);
      expect(await store.localDrafts("account")).toEqual([]);
      expect((await store.adoptedDrafts("account")).map((d) => d.id)).toEqual([
        "server-1",
      ]);
    } finally {
      store.close();
    }
  });

  test("a lost reply after an accepted push is recognized, not applied twice", async () => {
    const store = new NotesStore("r2-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Hello");
      const local = EditorState.create({ doc: base }).tr.insertText("!", 6).doc;
      const draft: Draft = {
        ...body,
        document: JSON.stringify(local.toJSON()),
        text: "Hello!",
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(draft);
      let accepted: Record<string, unknown> | undefined;
      const controller = live(store, {
        "history:read": () => ({
          revision: 0,
          doc: JSON.stringify(base.toJSON()),
          markdown: "Hello",
        }),
        "notes:push": (args) => {
          accepted = args;
          throw new Error("reply lost after commit");
        },
      });
      await controller.reconcileCreated("account", "note", draft);
      const journal = (await store.readDraft("account", "note"))!;
      expect(journal.clientId).toBe(accepted!.clientId);
      let reopened = EditorState.create({
        doc: base,
        plugins: [collab({ version: 0, clientID: journal.clientId! })],
      });
      const tr = reopened.tr;
      for (const step of journal.steps!)
        tr.step(Step.fromJSON(notesSchema, JSON.parse(step)));
      reopened = reopened.apply(tr);
      const echoed = (accepted!.steps as string[]).map((s) =>
        Step.fromJSON(notesSchema, JSON.parse(s)),
      );
      reopened = reopened.apply(
        receiveTransaction(
          reopened,
          echoed,
          echoed.map(() => accepted!.clientId as string),
        ),
      );
      expect(reopened.doc.textContent).toBe("Hello!");
    } finally {
      store.close();
    }
  });

  test("recovery keeps edits made by others since creation", async () => {
    const store = new NotesStore("r2-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Hello");
      const draft: Draft = {
        ...body,
        document: json("Hello!"),
        text: "Hello!",
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(draft);
      let serverText = "Hello collaborator";
      const controller = live(store, {
        "history:read": () => ({
          revision: 0,
          doc: JSON.stringify(base.toJSON()),
          markdown: "Hello",
        }),
        // Someone else edited since creation: the push at revision 0 is behind.
        "notes:push": () => ({ status: "behind", revision: 1 }),
        "notes:content": () => ({
          doc: json(serverText),
          revision: 1,
          role: "edit",
        }),
      });
      await controller.reconcileCreated("account", "note", draft);
      expect(serverText).toBe("Hello collaborator");
      const journal = (await store.readDraft("account", "note"))!;
      expect(journal.baseRevision).toBe(0);
      expect(journal.steps).toHaveLength(1);
      serverText = "";
    } finally {
      store.close();
    }
  });
});
