import "fake-indexeddb/auto";
import { applySafeStep, notesSchema } from "@palladian/notes-core";
import { getFunctionName } from "convex/server";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import type { NotesStore, Draft } from "../../src/cache";
import { LiveController } from "../../src/live";

export const text = (value: string) => notesSchema.text(value);
export const summary = {
  id: "note",
  title: "Plan",
  preview: "",
  editedAt: 1,
  notebookId: "nb",
  role: "edit",
  trashed: false,
};

/** One note on a fake server: its creation version and step log, with each step's sender. */
export class FakeNote {
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

export type Handler = (args: Record<string, unknown>) => unknown;
/** Server functions for the note with ID "note"; other notes are not found. */
export function server(note: FakeNote): Record<string, Handler> {
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
export function live(store: NotesStore, handlers: Record<string, Handler>) {
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

export function draftOf(
  local: ProseMirrorNode,
  extra: Partial<Draft> = {},
): Draft {
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

/**
 * Run `during` while the store's next read is gathering unsaved in-memory
 * snapshots, before it reads stored rows and fences.
 */
export async function pauseRecovery(
  store: NotesStore,
  during: () => Promise<unknown>,
) {
  const target = store as unknown as {
    recoverySnapshots: (...args: unknown[]) => Promise<unknown>;
  };
  const original = target.recoverySnapshots.bind(store);
  target.recoverySnapshots = async (...args) => {
    target.recoverySnapshots = original;
    const result = await original(...args);
    await during();
    return result;
  };
}
