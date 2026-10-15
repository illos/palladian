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
const summary = {
  id: "note",
  title: "private",
  preview: "",
  editedAt: 1,
  notebookId: "nb",
  role: "edit",
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
    openNotes: Set<string>;
    recheckAccess(accountId: string, ids: string[]): Promise<void>;
    reconcileCreated(
      accountId: string,
      noteId: string,
      draft: Draft,
    ): Promise<void>;
  };
}

async function fencedNote(store: NotesStore) {
  const fence = await store.captureFence("account");
  await store.cacheSummaries("account", [row], [], fence);
  await store.cacheAccepted(body, 1, fence);
  await store.revokeNotes("account", ["note"]);
  return fence;
}

describe("access rechecks", () => {
  test("a cache-capable query never lifts a fence", async () => {
    const store = new NotesStore("r3-" + crypto.randomUUID());
    try {
      const fence = await fencedNote(store);
      const controller = live(store, {
        // A stale subscription would still answer this; it must not be asked.
        "notes:get": () => ({ summary }),
        "notes:verifyAccess": () => ({ subject: "account", summary: null }),
      });
      await controller.recheckAccess("account", ["note"]);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
    } finally {
      store.close();
    }
  });

  test("an answer for another account or older than a new revocation is ignored", async () => {
    const name = "r3-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const fence = await fencedNote(store);
      await live(store, {
        "notes:verifyAccess": () => ({ subject: "someone-else", summary }),
      }).recheckAccess("account", ["note"]);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      // Another tab records a revocation while the server request is out.
      await live(store, {
        "notes:verifyAccess": async () => {
          await other.revokeNotes("account", ["note"]);
          return { subject: "account", summary };
        },
      }).recheckAccess("account", ["note"]);
      await expect(store.cacheAccepted(body, 1, fence)).rejects.toThrow(
        /removed/,
      );
      // A server answer for this account with no revocation since lifts it.
      await live(store, {
        "notes:verifyAccess": () => ({ subject: "account", summary }),
      }).recheckAccess("account", ["note"]);
      await store.cacheAccepted(body, 1, fence);
      expect((await store.read("account", "note"))!.text).toBe("private");
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("creation recovery", () => {
  test("newer typing during recovery is kept, not replaced by the older journal", async () => {
    const store = new NotesStore("r3-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Hello");
      const old: Draft = {
        ...body,
        document: json("Hello!"),
        text: "Hello!",
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(old);
      let release!: (value: unknown) => void;
      let pushed = false;
      const controller = live(store, {
        "notes:content": () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        "notes:push": () => {
          pushed = true;
          return { status: "behind", revision: 1 };
        },
      });
      const recovery = controller.reconcileCreated("account", "note", old);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await store.writeDraft({
        ...old,
        document: json("Hello! newer typing"),
        text: "Hello! newer typing",
        updatedAt: 2,
      });
      release({
        revision: 0,
        doc: JSON.stringify(base.toJSON()),
        role: "owner",
      });
      await recovery;
      const kept = (await store.readDraft("account", "note"))!;
      expect(kept.text).toBe("Hello! newer typing");
      expect(kept.baseRevision).toBeUndefined();
      expect(pushed).toBe(false);
      expect(
        (await store.exportDrafts("account")).find((d) => d.id === "note")!
          .text,
      ).toBe("Hello! newer typing");
    } finally {
      store.close();
    }
  });

  test("recovery defers to an open editor", async () => {
    const store = new NotesStore("r3-" + crypto.randomUUID());
    try {
      const old: Draft = {
        ...body,
        document: json("Hello!"),
        text: "Hello!",
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(old);
      const controller = live(store, {
        "notes:content": () => {
          controller.openNotes.add("note");
          return { revision: 0, doc: json("Hello"), role: "owner" };
        },
      });
      await controller.reconcileCreated("account", "note", old);
      expect(
        (await store.readDraft("account", "note"))!.baseRevision,
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("a created note stays created when a local editor saves it", async () => {
    const store = new NotesStore("r3-" + crypto.randomUUID());
    try {
      await store.writeDraft({ ...body, updatedAt: 1, created: true });
      // The local-draft editor does not know about server creation.
      const fresh = new NotesStore(
        (store as unknown as { db: { name: string } }).db.name,
      );
      try {
        await fresh.writeDraft({
          accountId: "account",
          id: "note",
          document: json("edited"),
          text: "edited",
          updatedAt: 2,
        });
        expect((await fresh.readDraft("account", "note"))!.created).toBe(true);
        expect(await fresh.localDrafts("account")).toEqual([]);
      } finally {
        fresh.close();
      }
    } finally {
      store.close();
    }
  });
});
