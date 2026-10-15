import "fake-indexeddb/auto";
import { markdownToDoc, notesSchema } from "@palladian/notes-core";
import { getFunctionName } from "convex/server";
import { collab, receiveTransaction } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";
import { Step, Transform } from "prosemirror-transform";
import type { Node as ProseMirrorNode } from "prosemirror-model";
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
    syncDrafts(): Promise<void>;
    reconcileCreated(
      accountId: string,
      noteId: string,
      draft: Draft,
    ): Promise<void>;
  };
}

/** Run recovery for `local` over `base`, then rebase the journal over `remote`. */
async function recoverAndRebase(
  store: NotesStore,
  base: ProseMirrorNode,
  local: ProseMirrorNode,
  remote: Transform,
) {
  const draft: Draft = {
    ...body,
    document: JSON.stringify(local.toJSON()),
    text: local.textContent,
    updatedAt: 1,
    created: true,
  };
  await store.writeDraft(draft);
  await live(store, {
    "history:read": () => ({
      revision: 0,
      doc: JSON.stringify(base.toJSON()),
      markdown: "",
    }),
    "notes:push": () => ({ status: "behind", revision: 1 }),
  }).reconcileCreated("account", "note", draft);
  const journal = (await store.readDraft("account", "note"))!;
  expect(journal.baseRevision).toBe(0);
  let state = EditorState.create({
    doc: base,
    plugins: [collab({ version: 0, clientID: journal.clientId! })],
  });
  const tr = state.tr;
  for (const step of journal.steps!)
    tr.step(Step.fromJSON(notesSchema, JSON.parse(step)));
  state = state.apply(tr);
  return state.apply(receiveTransaction(state, remote.steps, ["them"])).doc;
}

function textPos(doc: ProseMirrorNode, text: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text))
      found = pos + node.text!.indexOf(text);
  });
  return found;
}

const text = (value: string) => notesSchema.text(value);

describe("creation recovery merges", () => {
  test("emoji before the edits do not shift positions", async () => {
    const store = new NotesStore("r4-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("😀 Alpha middle Omega");
      const [alpha, omega, middle] = ["Alpha", "Omega", "middle"].map((w) =>
        textPos(base, w),
      ) as [number, number, number];
      const local = new Transform(base)
        .replaceWith(omega, omega + 5, text("OMEGA"))
        .replaceWith(alpha, alpha + 5, text("ALPHA")).doc;
      const remote = new Transform(base).replaceWith(
        middle,
        middle + 6,
        text("COLLABORATOR"),
      );
      const merged = await recoverAndRebase(store, base, local, remote);
      expect(merged.textContent).toBe("😀 ALPHA COLLABORATOR OMEGA");
    } finally {
      store.close();
    }
  });

  test("a long paragraph keeps a collaborator's edit in its middle", async () => {
    const store = new NotesStore("r4-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Alpha " + "x".repeat(2100) + " Omega");
      const end = base.content.size - 1;
      const local = new Transform(base)
        .replaceWith(end - 5, end, text("OMEGA"))
        .replaceWith(1, 6, text("ALPHA")).doc;
      const remote = new Transform(base).replaceWith(1000, 1001, text("Y"));
      const merged = await recoverAndRebase(store, base, local, remote);
      expect(merged.textContent).toMatch(/^ALPHA x+Yx+ OMEGA$/);
    } finally {
      store.close();
    }
  });
});

describe("creation recovery conflicts", () => {
  const base = markdownToDoc("a".repeat(3000));
  const local = markdownToDoc("b".repeat(3000));
  const server = markdownToDoc("a".repeat(3000) + " and a collaborator");

  test("versions too different to merge are both kept", async () => {
    const store = new NotesStore("r4-" + crypto.randomUUID());
    try {
      const draft: Draft = {
        ...body,
        document: JSON.stringify(local.toJSON()),
        text: local.textContent,
        updatedAt: 1,
        created: true,
        notebookId: "nb",
      };
      await store.writeDraft(draft);
      const pushes: unknown[] = [];
      const creates: Record<string, unknown>[] = [];
      const controller = live(store, {
        "history:read": () => ({
          revision: 0,
          doc: JSON.stringify(base.toJSON()),
          markdown: "",
        }),
        "notes:content": () => ({
          doc: JSON.stringify(server.toJSON()),
          revision: 3,
          role: "owner",
        }),
        "notes:push": (args) => {
          pushes.push(args);
          return { status: "behind", revision: 3 };
        },
        "notes:create": (args) => {
          creates.push(args);
          return { noteId: "copy", revision: 0, replayed: false };
        },
      });
      await controller.syncDrafts();
      expect(pushes).toEqual([]);
      // The note shows the server's version, collaborator included.
      expect((await store.read("account", "note"))!.text).toContain(
        "collaborator",
      );
      expect(await store.readDraft("account", "note")).toBeUndefined();
      // The local version was created as a separate note in the same notebook.
      expect(creates).toHaveLength(1);
      expect(creates[0]!.doc).toBe(draft.document);
      expect(creates[0]!.notebookId).toBe("nb");
      expect((await store.read("account", "copy"))!.text).toBe(
        local.textContent,
      );
    } finally {
      store.close();
    }
  });

  test("a split never replaces a draft that changed meanwhile", async () => {
    const store = new NotesStore("r4-" + crypto.randomUUID());
    try {
      const draft: Draft = {
        ...body,
        document: JSON.stringify(local.toJSON()),
        text: local.textContent,
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(draft);
      await store.writeDraft({ ...draft, text: "newer", updatedAt: 2 });
      const fence = await store.captureFence("account");
      const split = await store.splitConflict(
        draft,
        "local-copy",
        { ...body, document: JSON.stringify(server.toJSON()), revision: 3 },
        fence,
      );
      expect(split).toBe(false);
      expect((await store.readDraft("account", "note"))!.text).toBe("newer");
      expect(await store.readDraft("account", "local-copy")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
