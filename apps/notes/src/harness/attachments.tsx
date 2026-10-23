import { useState } from "react";
import { createRoot } from "react-dom/client";
import { notesSchema } from "@palladian/notes-core/schema";
import { receiveTransaction, sendableSteps } from "prosemirror-collab";
import { Step } from "prosemirror-transform";
import { ConvexError } from "convex/values";
import type { EditorView } from "prosemirror-view";
import type { EditorBinding } from "../binding";
import type { AttachmentService, UploadGrant } from "../attachments";
import { NoteEditor } from "../editor";
import { setFileWrites } from "../file-capability";
import { attachmentCache } from "../attachment-cache";
import "../theme.css";
import "../styles.css";

/**
 * Test-only page (harness/attachments.html, served by the dev server, not
 * built): the note editor bound like a live note, with a stand-in for the
 * server's file functions. The browser tests answer `/files/*` themselves
 * (Playwright routes), play a collaborator's steps into the editor and
 * confirm its own, and read what the editor asked the server for.
 */
const ACCOUNT = "harness-account";
const NOTE = "k1700000000000000000000000000note";

interface Harness {
  /** Calls the editor made: createUpload (with the object it got) and cancelUpload. */
  calls: { name: string; args: Record<string, unknown>; objectId?: string }[];
  /** The next createUpload fails with this message, once. */
  failNextCreate: string | null;
  connected: boolean;
  doc(): unknown;
  setFiles(on: boolean): void;
  setEditable(editable: boolean): void;
  /** Answer `files.noteObjects` for the note: object IDs, or null (unknown). */
  setObjects(ids: string[] | null): void;
  /** Steps from a collaborator, as the server would relay them. */
  remote(steps: unknown[]): void;
  /** The server accepted this editor's unsent steps. */
  confirm(): void;
  /** Start again with another document (JSON). */
  load(doc: unknown): void;
  /** Close the note (the editor unmounts). */
  close(): void;
}
declare global {
  interface Window {
    __attachments: Harness;
  }
}

let view: EditorView | null = null;
let objects: ((ids: ReadonlySet<string> | null) => void) | null = null;
let known: ReadonlySet<string> | null = null;
const requests = new Map<
  string,
  { objectId: string; state: UploadGrant["state"] }
>();
let counter = 0;

const harness: Harness = {
  calls: [],
  failNextCreate: null,
  connected: true,
  doc: () => view?.state.doc.toJSON() ?? null,
  setFiles: setFileWrites,
  setEditable: () => undefined,
  setObjects(ids) {
    known = ids ? new Set(ids) : null;
    objects?.(known);
  },
  remote(steps) {
    if (!view) return;
    const parsed = steps.map((step) => Step.fromJSON(notesSchema, step));
    view.dispatch(
      receiveTransaction(
        view.state,
        parsed,
        parsed.map(() => "collaborator"),
      ),
    );
  },
  confirm() {
    if (!view) return;
    const sendable = sendableSteps(view.state);
    if (!sendable) return;
    view.dispatch(
      receiveTransaction(
        view.state,
        sendable.steps,
        sendable.steps.map(() => sendable.clientID),
      ),
    );
  },
  load: () => undefined,
  close: () => undefined,
};
window.__attachments = harness;

const service: AttachmentService = {
  accountId: ACCOUNT,
  connected: () => harness.connected,
  async createUpload(args) {
    const call: Harness["calls"][number] = {
      name: "createUpload",
      args: { ...args },
    };
    harness.calls.push(call);
    if (harness.failNextCreate) {
      const message = harness.failNextCreate;
      harness.failNextCreate = null;
      throw new ConvexError({ code: "too_large", message });
    }
    let request = requests.get(args.requestId);
    if (!request) {
      request = {
        objectId: "k" + String(++counter).padStart(31, "0"),
        state: "pending",
      };
      requests.set(args.requestId, request);
    }
    call.objectId = request.objectId;
    return {
      objectId: request.objectId,
      state: request.state,
      ticket: request.state === "pending" ? "t".repeat(43) : null,
      name: args.name,
      mimeType: args.mimeType || "application/octet-stream",
    };
  },
  async cancelUpload(objectId) {
    harness.calls.push({ name: "cancelUpload", args: { objectId } });
  },
  token: async () => "harness-token",
  watchNoteObjects(_noteId, changed) {
    objects = changed;
    changed(known);
    return () => {
      objects = null;
    };
  },
};

const binding: EditorBinding = {
  version: 0,
  clientId: "harness-client",
  pending: [],
  attach(editor) {
    view = editor;
    return () => {
      if (view === editor) view = null;
    };
  },
  changed: () => undefined,
};

const album = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "title" },
      content: [{ type: "text", text: "Album" }],
    },
    {
      type: "paragraph",
      attrs: { id: "first" },
      content: [{ type: "text", text: "First line." }],
    },
    {
      type: "paragraph",
      attrs: { id: "second" },
      content: [{ type: "text", text: "Second line." }],
    },
  ],
};

void attachmentCache.retain(ACCOUNT);

function Harness() {
  const [doc, setDoc] = useState<unknown>(album);
  const [generation, setGeneration] = useState(0);
  const [editable, setEditable] = useState(true);
  const [open, setOpen] = useState(true);
  harness.setEditable = setEditable;
  harness.load = (next) => {
    setDoc(next);
    setGeneration((value) => value + 1);
    setOpen(true);
  };
  harness.close = () => setOpen(false);
  if (!open) return <p>Closed</p>;
  return (
    <section className="note-content-region">
      <NoteEditor
        key={generation}
        document={JSON.stringify(doc)}
        editable={editable}
        onChange={() => undefined}
        binding={binding}
        attachments={{ accountId: ACCOUNT, noteId: NOTE, service }}
      />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
