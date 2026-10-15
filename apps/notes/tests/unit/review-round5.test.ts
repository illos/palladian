import "fake-indexeddb/auto";
import {
  applySafeStep,
  contentKey,
  markdownToDoc,
  notesSchema,
  plainText,
} from "@palladian/notes-core";
import { getFunctionName } from "convex/server";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import { describe, expect, test } from "vitest";
import { NotesStore, type Draft } from "../../src/cache";
import { LiveController } from "../../src/live";

const text = (value: string) => notesSchema.text(value);
const summary = {
  id: "note",
  title: "Plan",
  preview: "",
  editedAt: 1,
  notebookId: "nb",
  role: "edit",
  trashed: false,
};

/** One note on a fake server: its creation version and step log, with each step's sender. */
class FakeNote {
  doc: ProseMirrorNode;
  readonly origin: ProseMirrorNode;
  readonly log: { step: string; clientId: string }[] = [];
  readonly pushes: Record<string, unknown>[] = [];
  readonly creates: Record<string, unknown>[] = [];
  accessible = true;
  constructor(origin: ProseMirrorNode) {
    this.origin = origin;
    this.doc = origin;
  }
  get revision() {
    return this.log.length;
  }
  commit(steps: Step[], clientId: string) {
    for (const step of steps) {
      this.doc = applySafeStep(this.doc, step);
      this.log.push({ step: JSON.stringify(step.toJSON()), clientId });
    }
  }
  /** Someone else's edit, accepted by the server. */
  edit(change: (tr: Transform) => void) {
    const tr = new Transform(this.doc);
    change(tr);
    this.commit(tr.steps, "them");
  }
}

type Handler = (args: Record<string, unknown>) => unknown;
/** Server functions for the note with ID "note"; other notes are not found. */
function server(note: FakeNote): Record<string, Handler> {
  return {
    "notes:content": (args) =>
      note.accessible && args.noteId === "note"
        ? {
            doc: JSON.stringify(note.doc.toJSON()),
            revision: note.revision,
            role: "edit",
          }
        : null,
    "notes:steps": (args) => {
      const after = args.after as number;
      return {
        steps: note.log.slice(after, after + 2),
        from: after,
        more: note.log.length > after + 2,
      };
    },
    "history:read": () => ({
      revision: 0,
      doc: JSON.stringify(note.origin.toJSON()),
      markdown: "",
    }),
    "notes:push": (args) => {
      if (args.noteId !== "note") throw new Error("Note not found.");
      note.pushes.push(args);
      if (args.revision !== note.revision)
        return { status: "behind", revision: note.revision };
      note.commit(
        (args.steps as string[]).map((step) =>
          Step.fromJSON(notesSchema, JSON.parse(step)),
        ),
        args.clientId as string,
      );
      return { status: "accepted", revision: note.revision };
    },
    "notes:verifyAccess": () => ({
      subject: "account",
      summary: note.accessible ? summary : null,
    }),
    "notes:create": (args) => {
      note.creates.push(args);
      return {
        noteId: "copy-" + note.creates.length,
        revision: 0,
        replayed: false,
      };
    },
  };
}

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
    fetching: 3,
    listeners: new Set(),
  });
  return instance;
}

function draftOf(local: ProseMirrorNode, extra: Partial<Draft> = {}): Draft {
  return {
    accountId: "account",
    id: "note",
    document: JSON.stringify(local.toJSON()),
    text: local.textContent,
    updatedAt: 1,
    created: true,
    notebookId: "nb",
    ...extra,
  };
}

/** Local edits that a diff of saved snapshots cannot safely rebase. */
const cases: [string, string, (base: ProseMirrorNode) => ProseMirrorNode][] = [
  [
    "bold without text changes",
    "Alpha middle Omega",
    (base) =>
      new Transform(base).addMark(
        1,
        base.content.size - 1,
        notesSchema.marks.strong!.create(),
      ).doc,
  ],
  [
    "a new first paragraph and changed words",
    "Alpha middle Omega",
    (base) => {
      const tr = new Transform(base)
        .replaceWith(14, 19, text("OMEGA"))
        .replaceWith(1, 6, text("ALPHA"));
      return tr.insert(
        0,
        notesSchema.nodes.paragraph!.create(null, text("Introduction")),
      ).doc;
    },
  ],
  [
    "swapped paragraphs",
    "First alpha\n\nSecond beta",
    (base) => notesSchema.node("doc", null, [base.child(1), base.child(0)]),
  ],
  [
    "emoji before changed words",
    "😀 Alpha middle Omega",
    (base) =>
      new Transform(base)
        .replaceWith(17, 22, text("OMEGA"))
        .replaceWith(4, 9, text("ALPHA")).doc,
  ],
  [
    "a long paragraph",
    "Alpha " + "x".repeat(2100) + " Omega",
    (base) => {
      const end = base.content.size - 1;
      return new Transform(base)
        .replaceWith(end - 5, end, text("OMEGA"))
        .replaceWith(1, 6, text("ALPHA")).doc;
    },
  ],
];

describe("creation recovery never rebases a saved draft", () => {
  for (const [name, markdown, change] of cases) {
    test(`someone else's edit is kept, with ${name}`, async () => {
      const store = new NotesStore("r5-" + crypto.randomUUID());
      try {
        const base = markdownToDoc(markdown);
        const local = change(base);
        const note = new FakeNote(base);
        note.edit((tr) => tr.insert(3, text("COLLABORATOR")));
        const theirs = contentKey(note.doc);
        const draft = draftOf(local);
        await store.writeDraft(draft);
        await live(store, server(note)).syncDrafts();
        // Nothing was sent over the collaborator's version.
        expect(note.pushes).toEqual([]);
        expect(contentKey(note.doc)).toBe(theirs);
        expect((await store.read("account", "note"))!.text).toContain(
          "COLLABORATOR",
        );
        expect(await store.readDraft("account", "note")).toBeUndefined();
        // The local version became a separate note in the same notebook.
        expect(note.creates).toHaveLength(1);
        expect(note.creates[0]).toMatchObject({
          doc: draft.document,
          notebookId: "nb",
          sourceNoteId: "note",
        });
        expect((await store.read("account", "copy-1"))!.text).toBe(
          local.textContent,
        );
      } finally {
        store.close();
      }
    });

    test(`with no one else's edits the note becomes the draft, with ${name}`, async () => {
      const store = new NotesStore("r5-" + crypto.randomUUID());
      try {
        const base = markdownToDoc(markdown);
        const local = change(base);
        const note = new FakeNote(base);
        await store.writeDraft(draftOf(local));
        await live(store, server(note)).syncDrafts();
        expect(note.pushes).toHaveLength(1);
        expect(note.pushes[0]!.revision).toBe(0);
        expect(contentKey(note.doc)).toBe(contentKey(local));
        expect(await store.readDraft("account", "note")).toBeUndefined();
        expect((await store.read("account", "note"))!.text).toBe(
          plainText(local),
        );
        expect(note.creates).toEqual([]);
      } finally {
        store.close();
      }
    });
  }

  test("a send whose reply was lost is recognized, also after more typing", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Hello");
      const note = new FakeNote(base);
      const first = new Transform(base).insert(6, text(" world")).doc;
      await store.writeDraft(draftOf(first));
      const handlers = server(note);
      const accept = handlers["notes:push"]!;
      await live(store, {
        ...handlers,
        "notes:push": (args) => {
          accept(args);
          throw new Error("reply lost after commit");
        },
      }).syncDrafts();
      expect(contentKey(note.doc)).toBe(contentKey(first));
      const afterFirst = note.revision;
      const kept = (await store.readDraft("account", "note"))!;
      expect(kept.clientId).toBe(note.pushes[0]!.clientId);
      // The local editor saves content only; the recovery's client ID stays.
      const newer = new Transform(first).insert(12, text("!")).doc;
      await store.writeDraft({
        accountId: "account",
        id: "note",
        document: JSON.stringify(newer.toJSON()),
        text: newer.textContent,
        updatedAt: 2,
      });
      await live(store, handlers).syncDrafts();
      expect(note.pushes).toHaveLength(2);
      expect(note.pushes[1]!.revision).toBe(afterFirst);
      expect(contentKey(note.doc)).toBe(contentKey(newer));
      expect(await store.readDraft("account", "note")).toBeUndefined();
      expect(note.creates).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a send that loses the race to another edit keeps both versions", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      const base = markdownToDoc("Alpha middle Omega");
      const note = new FakeNote(base);
      const local = new Transform(base).replaceWith(1, 6, text("ALPHA")).doc;
      await store.writeDraft(draftOf(local));
      const handlers = server(note);
      const push = handlers["notes:push"]!;
      await live(store, {
        ...handlers,
        "notes:push": (args) => {
          note.edit((tr) => tr.insert(7, text("COLLABORATOR ")));
          return push(args);
        },
      }).syncDrafts();
      expect(note.pushes[0]).toMatchObject({ revision: 0 });
      expect(note.doc.textContent).toBe("Alpha COLLABORATOR middle Omega");
      await live(store, handlers).syncDrafts();
      expect(note.doc.textContent).toBe("Alpha COLLABORATOR middle Omega");
      expect(note.pushes).toHaveLength(1);
      expect(note.creates).toHaveLength(1);
      expect((await store.read("account", "copy-1"))!.text).toBe(
        local.textContent,
      );
    } finally {
      store.close();
    }
  });
});

describe("conflict copies are authorized as their source note", () => {
  /** Split a conflicting draft whose copy could not be created yet. */
  async function pendingCopy(store: NotesStore) {
    const fence = await store.captureFence("account");
    await store.cacheSummaries(
      "account",
      [
        {
          id: "note",
          title: "Plan",
          preview: "",
          updatedAt: 1,
          notebookId: "nb",
          role: "edit",
          trashed: false,
        },
      ],
      [],
      fence,
    );
    const base = markdownToDoc("Confidential plan");
    const note = new FakeNote(base);
    note.edit((tr) => tr.insert(1, text("Shared ")));
    const local = markdownToDoc("Confidential plan, revised");
    await store.writeDraft(draftOf(local));
    await live(store, {
      ...server(note),
      "notes:create": () => {
        throw new Error("transport interrupted");
      },
    }).syncDrafts();
    const [copy] = await store.localDrafts("account");
    expect(copy).toMatchObject({ source: "note", notebookId: "nb" });
    return { note, copy: copy! };
  }

  test("losing the notebook removes a pending copy and its export", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      const { copy } = await pendingCopy(store);
      const fence = await store.captureFence("account");
      await store.reconcileAccess("account", new Set(), new Set(), fence);
      expect(await store.read("account", "note")).toBeUndefined();
      expect(await store.localDrafts("account")).toEqual([]);
      expect(await store.exportDrafts("account")).toEqual([]);
      // A stale editor of the copy, saving content only, cannot bring it back.
      const { source: _source, ...content } = copy;
      await expect(
        store.writeDraft({ ...content, updatedAt: 9 }),
      ).rejects.toThrow(/removed/);
    } finally {
      store.close();
    }
  });

  test("a copy stays while its source is shared individually", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      await pendingCopy(store);
      const fence = await store.captureFence("account");
      await store.reconcileAccess(
        "account",
        new Set(),
        new Set(["note"]),
        fence,
      );
      expect(await store.localDrafts("account")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("revoking the source removes the copy, including unsaved typing in another tab", async () => {
    const name = "r5-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const { copy } = await pendingCopy(store);
      // The local editor saves content only; the copy keeps its source and notebook.
      await other.writeDraft({
        accountId: "account",
        id: copy.id,
        document: copy.document,
        text: "typed in another tab",
        updatedAt: 5,
      });
      expect(await other.readDraft("account", copy.id)).toMatchObject({
        source: "note",
        notebookId: "nb",
      });
      await store.revokeNotes("account", ["note"]);
      expect(await other.exportDrafts("account")).toEqual([]);
      expect(await store.exportDrafts("account")).toEqual([]);
      expect(await store.localDrafts("account")).toEqual([]);
    } finally {
      store.close();
      other.close();
    }
  });

  test("a copy whose source is no longer accessible is removed, not created", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      const { note } = await pendingCopy(store);
      note.accessible = false;
      await live(store, server(note)).syncDrafts();
      expect(note.creates).toEqual([]);
      expect(await store.localDrafts("account")).toEqual([]);
      expect(await store.exportDrafts("account")).toEqual([]);
      expect(await store.read("account", "note")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("once created, a copy is a note of its own", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      const { note } = await pendingCopy(store);
      await live(store, server(note)).syncDrafts();
      expect(note.creates[0]).toMatchObject({ sourceNoteId: "note" });
      const created = (await store.readDraft("account", "copy-1"))!;
      expect(created.source).toBeUndefined();
      await store.revokeNotes("account", ["note"]);
      expect(await store.readDraft("account", "copy-1")).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("a note created from this device goes with its notebook before its summary arrives", async () => {
    const store = new NotesStore("r5-" + crypto.randomUUID());
    try {
      await store.writeDraft(draftOf(markdownToDoc("Team work")));
      const { created: _created, ...unsent } = draftOf(
        markdownToDoc("Not sent yet"),
        { id: "local-new" },
      );
      await store.writeDraft(unsent);
      const fence = await store.captureFence("account");
      await store.reconcileAccess("account", new Set(), new Set(), fence);
      expect(await store.readDraft("account", "note")).toBeUndefined();
      // A note never sent to the server is kept, as before.
      expect((await store.exportDrafts("account")).map((d) => d.id)).toEqual([
        "local-new",
      ]);
    } finally {
      store.close();
    }
  });
});
