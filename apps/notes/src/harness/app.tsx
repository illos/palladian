import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { applySafeStep, notesSchema } from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Step } from "prosemirror-transform";
import { App } from "../App";
import { createNotesStore, type ActivationFence } from "../cache";
import type { NoteTransport, StepBatch } from "../channel";
import { LiveController } from "../live";
import { LiveBox } from "../liveBox";
import {
  browserAccountHints,
  SessionController,
  type SessionService,
} from "../session";
import "../theme.css";
import "../styles.css";

/**
 * Test-only page (harness/app.html, served by the dev server, not built):
 * the real app, notes cache and session, signed in and connected to a
 * stand-in for the Convex client that keeps notes, step logs and file
 * objects in this page. The browser tests make file notes from the list
 * through it (plan 08 B4, review round 1, F3 and F4), hold or lose its
 * answers, and answer the Worker's `/files/*` with Playwright routes. Real
 * services: apps/notes/scripts/file-notes-e2e.mjs.
 */
const ACCOUNT = "harness-account";
const NOTEBOOK = "k1700000000000000000000000000book";

interface ServerNote {
  id: string;
  notebookId: string;
  doc: ProseMirrorNode;
  log: { step: string; clientId: string }[];
}
interface Harness {
  /** `notes.create` calls: their creation keys and accounts. */
  creates: { clientKey: string; account: unknown }[];
  /** Each note on the server: its top-level blocks, as tests read them. */
  notes(): { id: string; blocks: string[] }[];
  /** `notes.create` waits until `releaseCreates`. */
  holdCreates: boolean;
  releaseCreates(): void;
  /** The next `notes.create` commits, then its answer is lost. */
  loseNextCreate: boolean;
  /** The next note read (`notes.content`, an open) waits until `releaseContent`. */
  holdNextContent: boolean;
  releaseContent(): void;
  setFiles(on: boolean): void;
}
declare global {
  interface Window {
    __app: Harness;
  }
}

const notes = new Map<string, ServerNote>();
const keys = new Map<string, string>();
const requests = new Map<string, string>();
const watchers = new Set<() => void>();
let files = true;
let counter = 0;
const id = (kind: string) =>
  kind + String(++counter).padStart(31 - kind.length, "0") + "x";
const changed = () => {
  for (const update of [...watchers]) update();
};
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
let creates = gate();
let contents = gate();

const blocksOf = (doc: ProseMirrorNode) => {
  const blocks: string[] = [];
  doc.forEach((node) =>
    blocks.push(
      node.type.name === "image"
        ? `image:${String(node.attrs.src)}`
        : node.type.name === "file"
          ? `file:${String(node.attrs.name)}`
          : node.textContent,
    ),
  );
  return blocks;
};

const harness: Harness = {
  creates: [],
  notes: () =>
    [...notes.values()].map((note) => ({
      id: note.id,
      blocks: blocksOf(note.doc),
    })),
  holdCreates: false,
  releaseCreates() {
    harness.holdCreates = false;
    creates.open();
    creates = gate();
  },
  loseNextCreate: false,
  holdNextContent: false,
  releaseContent() {
    contents.open();
    contents = gate();
  },
  setFiles(on) {
    files = on;
    changed();
  },
};
window.__app = harness;

/** What the stand-in answers synchronously (queries and watches). */
function query(name: string, args: Record<string, unknown>): unknown {
  const note = notes.get(String(args.noteId));
  switch (name) {
    case "files:capabilities":
      return { writes: files };
    case "notebooks:capabilities":
      return { delete: false };
    case "notes:content":
      return note
        ? {
            doc: JSON.stringify(note.doc.toJSON()),
            revision: note.log.length,
            role: "owner",
          }
        : null;
    case "notes:steps": {
      const after = Number(args.after);
      return {
        from: after,
        steps: note ? note.log.slice(after) : [],
        more: false,
      } satisfies StepBatch;
    }
    case "files:noteObjects": {
      const objects: { objectId: string; state: string }[] = [];
      note?.doc.descendants((node) => {
        const objectId =
          node.type.name === "file"
            ? String(node.attrs.objectId)
            : node.type.name === "image"
              ? String(node.attrs.src).replace(/^attachment:/, "")
              : null;
        if (objectId) objects.push({ objectId, state: "ready" });
      });
      return objects;
    }
    case "library:search":
      return [];
  }
  throw new Error("The harness has no " + name);
}

async function mutation(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "notes:create": {
      harness.creates.push({
        clientKey: String(args.clientKey),
        account: args.account,
      });
      if (harness.holdCreates) await creates.opened;
      if (args.account !== undefined && args.account !== ACCOUNT)
        throw new Error("This change was made in another account.");
      const replayed = keys.get(String(args.clientKey));
      if (replayed) return { noteId: replayed, revision: 0, replayed: true };
      const note: ServerNote = {
        id: id("n"),
        notebookId: String(args.notebookId ?? NOTEBOOK),
        doc: notesSchema.nodeFromJSON(JSON.parse(String(args.doc))),
        log: [],
      };
      notes.set(note.id, note);
      keys.set(String(args.clientKey), note.id);
      changed();
      if (harness.loseNextCreate) {
        harness.loseNextCreate = false;
        throw new Error("Connection lost before the answer arrived.");
      }
      return { noteId: note.id, revision: 0, replayed: false };
    }
    case "notes:push": {
      const note = notes.get(String(args.noteId));
      if (!note) throw new Error("Note not found.");
      if (args.revision !== note.log.length)
        return { status: "behind", revision: note.log.length };
      for (const step of args.steps as string[]) {
        note.doc = applySafeStep(
          note.doc,
          Step.fromJSON(notesSchema, JSON.parse(step)),
        );
        note.log.push({ step, clientId: String(args.clientId) });
      }
      changed();
      return { status: "accepted", revision: note.log.length };
    }
    case "files:createUpload": {
      const request = String(args.requestId);
      const objectId = requests.get(request) ?? id("o");
      requests.set(request, objectId);
      return {
        objectId,
        state: "pending",
        ticket: "t".repeat(43),
        expiresAt: Date.now() + 3_600_000,
        name: String(args.name),
        mimeType: String(args.mimeType || "application/octet-stream"),
        replayed: false,
      };
    }
    case "files:cancelUpload":
      return null;
  }
  throw new Error("The harness has no " + name);
}

const client = {
  async query(reference: unknown, args: Record<string, unknown>) {
    const name = getFunctionName(reference as never);
    if (name === "notes:content" && harness.holdNextContent) {
      harness.holdNextContent = false;
      await contents.opened;
    }
    return query(name, args);
  },
  mutation: (reference: unknown, args: Record<string, unknown>) =>
    mutation(getFunctionName(reference as never), args),
  watchQuery(reference: unknown, args: Record<string, unknown>) {
    const name = getFunctionName(reference as never);
    const listeners = new Set<() => void>();
    const update = () => {
      for (const listener of [...listeners]) listener();
    };
    return {
      localQueryResult: () => query(name, args),
      onUpdate(listener: () => void) {
        listeners.add(listener);
        watchers.add(update);
        return () => {
          listeners.delete(listener);
          if (!listeners.size) watchers.delete(update);
        };
      },
    };
  },
};

const transport: NoteTransport = {
  create: async (args) =>
    (await mutation("notes:create", args)) as {
      noteId: string;
      revision: number;
    },
  push: async (args) =>
    (await mutation("notes:push", args)) as {
      status: "accepted" | "behind";
      revision: number;
    },
  subscribeSteps(noteId, after, onBatch) {
    const read = () =>
      onBatch(query("notes:steps", { noteId, after }) as StepBatch);
    watchers.add(read);
    queueMicrotask(read);
    return () => void watchers.delete(read);
  },
};

/** A JWT for this account, unsigned: the app only reads its subject. */
const encode = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const token = `${encode({ alg: "none" })}.${encode({ sub: ACCOUNT, exp: 4_000_000_000 })}.sig`;

// The app's session and notes cache, as main.tsx wires them for fixtures.
const store = createNotesStore();
const hints = browserAccountHints(localStorage);
hints.remember(ACCOUNT);
let activation: ActivationFence | null = null;
const service: SessionService = {
  async check() {
    activation = await store.captureActivationFence();
    return { kind: "ready", accountId: ACCOUNT };
  },
};
const session = new SessionController({
  service,
  hints,
  async clearAccount(accountId, operation) {
    await store.clearAccount(accountId, operation);
  },
  finishCleanup: (accountId) => store.finishClear(accountId),
  settleAccount: async () => true,
  async onAccountReady(accountId, isCurrent) {
    if (!activation || !isCurrent()) throw new Error("Session attempt changed");
    await store.allowAccount(accountId, activation, isCurrent);
  },
  prepareLogout: async () => true,
});

// The live layer, signed in and connected, over the stand-in client (as
// the unit tests' fake-server.ts builds one).
const listeners = new Set<() => void>();
const live: LiveController = Object.create(LiveController.prototype);
const state = {
  ready: true,
  accountId: ACCOUNT,
  profile: null,
  connected: true,
};
Object.assign(live, {
  client,
  auth: {
    convex: { token: async () => ({ data: { token } }) },
  },
  store,
  session,
  state,
  listeners,
  stops: [],
  feeds: new Map(),
  openNotes: new Set(),
  fetchQueue: new Map(),
  fetching: 0,
  syncingDrafts: false,
  getState: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  transport,
});
const liveBox = new LiveBox();
liveBox.set(live);

createRoot(document.getElementById("root")!).render(
  <App session={session} store={store} liveBox={liveBox} />,
);
