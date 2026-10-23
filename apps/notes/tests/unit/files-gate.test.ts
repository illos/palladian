import "fake-indexeddb/auto";
import {
  fileFeatures,
  markdownToDoc,
  notesSchema,
  stepAddsFileFeatures,
  usesFileFeatures,
} from "@palladian/notes-core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Slice } from "prosemirror-model";
import { collab } from "prosemirror-collab";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { Step } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import {
  NoteChannel,
  TransportError,
  type ChannelStatus,
  type NoteTransport,
  type StepBatch,
} from "../../src/channel";
import {
  loadMarkdown,
  pasteMarkdown,
  safeSlice,
} from "../../src/editor-clipboard";
import { setFileWrites } from "../../src/file-capability";

/**
 * Review round 4 of B1+B2 (R4-1): while the server does not accept file
 * features, pasted content keeps them out, so the server never refuses an
 * edit and the note keeps saving. Runs the real channel and editor state
 * against a server that applies the files gate.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const GATED = [
  "![web](https://example.com/w.png){width=300}",
  `![photo](attachment:${OBJECT})`,
  `[report.pdf](attachment:${OBJECT}){type=application/pdf size=3}`,
  `> [quoted.pdf](attachment:${OBJECT})`,
].join("\n\n");

afterEach(() => setFileWrites(false));

/** A note on a server that refuses steps adding file features while gated. */
function server(start: ProseMirrorNode, gated: boolean) {
  const state = {
    doc: start,
    log: [] as { step: string; clientId: string }[],
    refused: 0,
  };
  let active: { after: number; onBatch: (batch: StepBatch) => void } | null =
    null;
  const deliver = () => {
    const subscription = active;
    if (subscription)
      setTimeout(() =>
        subscription.onBatch({
          from: subscription.after,
          steps: state.log.slice(subscription.after),
          more: false,
        }),
      );
  };
  const transport: NoteTransport = {
    create: async () => {
      throw new Error("not used");
    },
    push: async ({ revision, steps, clientId }) => {
      if (revision !== state.log.length)
        return { status: "behind", revision: state.log.length };
      const existing = fileFeatures(state.doc);
      let doc = state.doc;
      for (const json of steps) {
        const step = Step.fromJSON(notesSchema, JSON.parse(json));
        if (gated && stepAddsFileFeatures(step, doc, existing)) {
          state.refused++;
          throw new TransportError(
            "invalid",
            "Files and image sizes are not enabled on this server yet.",
          );
        }
        doc = step.apply(doc).doc!;
      }
      state.doc = doc;
      for (const step of steps) state.log.push({ step, clientId });
      deliver();
      return { status: "accepted", revision: state.log.length };
    },
    subscribeSteps: (_noteId, after, onBatch) => {
      active = { after, onBatch };
      deliver();
      return () => {
        if (active?.onBatch === onBatch) active = null;
      };
    },
  };
  return { state, transport };
}

/** An editor on the note, bound to a real channel. */
async function open(start: ProseMirrorNode, transport: NoteTransport) {
  const store = new NotesStore("files-gate-" + crypto.randomUUID());
  await store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );
  const statuses: ChannelStatus[] = [];
  const channel = new NoteChannel({
    store,
    accountId: "account",
    noteId: "note",
    created: true,
    baseDocument: JSON.stringify(start.toJSON()),
    baseRevision: 0,
    clientId: "me",
    pending: [],
    onStatus: (status) => statuses.push(status),
  });
  const view = {
    editable: true,
    state: EditorState.create({
      doc: start,
      plugins: [collab({ version: 0, clientID: "me" })],
      selection: TextSelection.atEnd(start),
    }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
      channel.changed(view as unknown as EditorView, tr);
    },
  };
  channel.attach(view as unknown as EditorView);
  channel.connect(transport);
  return { view, channel, statuses, store };
}

function pasteText(view: unknown, text: string) {
  return pasteMarkdown(
    view as EditorView,
    {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    } as unknown as ClipboardEvent,
    Slice.empty,
  );
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("R4-1: pasted file features stay out while files are off", () => {
  test("paste, then typing before the server answers: all saved, nothing refused", async () => {
    await loadMarkdown();
    const start = markdownToDoc("Note\n\nStart");
    const { state, transport } = server(start, true);
    const { view, channel, statuses, store } = await open(start, transport);
    try {
      await flush();
      expect(pasteText(view, GATED)).toBe(true);
      // Typing right after the paste, before its push is answered.
      view.dispatch(view.state.tr.insertText(" and more typing"));
      await flush();
      expect(state.refused).toBe(0);
      expect(statuses.some((s) => s.kind === "blocked")).toBe(false);
      expect(channel.ready).toBe(true);
      // The server has everything, with no file features.
      expect(usesFileFeatures(state.doc)).toBe(false);
      const text = state.doc.textBetween(0, state.doc.content.size, "\n");
      expect(text).toContain("photo");
      expect(text).toContain("report.pdf");
      expect(text).toContain("quoted.pdf");
      expect(text).toContain("and more typing");
      let web = false;
      state.doc.descendants((node) => {
        if (node.type.name === "image")
          web = node.attrs.src === "https://example.com/w.png";
        return true;
      });
      expect(web).toBe(true);
      // Reopening shows what the server has.
      channel.close();
      const again = await open(state.doc, transport);
      expect(again.view.state.doc.eq(state.doc)).toBe(true);
      again.channel.close();
      again.store.close();
    } finally {
      store.close();
    }
  });

  test("with files on, the same paste keeps them and the server accepts", async () => {
    await loadMarkdown();
    setFileWrites(true);
    const start = markdownToDoc("Note\n\nStart");
    const { state, transport } = server(start, false);
    const { view, channel, statuses, store } = await open(start, transport);
    try {
      await flush();
      expect(pasteText(view, GATED)).toBe(true);
      await flush();
      expect(statuses.some((s) => s.kind === "blocked")).toBe(false);
      expect(usesFileFeatures(state.doc)).toBe(true);
      let file = 0;
      let width = 0;
      state.doc.descendants((node) => {
        if (node.type.name === "file") file++;
        if (node.type.name === "image" && node.attrs.width === 300) width++;
        return true;
      });
      expect(file).toBe(2);
      expect(width).toBe(1);
      channel.close();
    } finally {
      store.close();
    }
  });

  test("HTML and dropped content: file blocks and attachment images become text", () => {
    const image = notesSchema.nodes.image!;
    const file = notesSchema.nodes.file!;
    const paragraph = notesSchema.nodes.paragraph!;
    const blockquote = notesSchema.nodes.blockquote!;
    const slice = new Slice(
      notesSchema.topNodeType.create(null, [
        paragraph.create(null, notesSchema.text("Before")),
        image.create({
          src: `attachment:${OBJECT}`,
          alt: "A photo",
          width: 300,
        }),
        image.create({ src: `attachment:${OBJECT}` }),
        image.create({ src: "https://example.com/w.png", width: 120 }),
        blockquote.create(null, [
          file.create({ objectId: OBJECT, name: "in quote.pdf" }),
        ]),
      ]).content,
      0,
      0,
    );
    const off = safeSlice(slice);
    const doc = notesSchema.topNodeType.create(null, off.content);
    doc.check();
    expect(usesFileFeatures(doc)).toBe(false);
    expect(doc.textBetween(0, doc.content.size, "|", "")).toBe(
      "Before|A photo|in quote.pdf",
    );
    // The web image stays, without its width.
    const images: unknown[] = [];
    doc.descendants((node) => {
      if (node.type.name === "image") images.push(node.attrs);
      return true;
    });
    expect(images).toMatchObject([
      { src: "https://example.com/w.png", width: null },
    ]);
    setFileWrites(true);
    expect(
      usesFileFeatures(
        notesSchema.topNodeType.create(null, safeSlice(slice).content),
      ),
    ).toBe(true);
  });
});
