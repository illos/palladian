import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { getFunctionName } from "convex/server";
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
      await store.revokeNotes("account", ["note"]);
      const before = await store.revocationMarkers("account", ["note"]);
      // A later revocation replaces the marker a check captured earlier.
      await store.revokeNotes("account", ["note"]);
      expect(await store.cacheSummaries("account", [row], [], fence)).toEqual([
        "note",
      ]);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      expect(await store.read("account", "note")).toBeUndefined();
      await store.allowNotes(
        "account",
        [{ id: "note", marker: before.get("note")! }],
        fence,
      );
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      const current = await store.revocationMarkers("account", ["note"]);
      await store.allowNotes(
        "account",
        [{ id: "note", marker: current.get("note")! }],
        fence,
      );
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
});
