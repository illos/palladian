import "fake-indexeddb/auto";
import {
  applySafeStep,
  attachmentIds,
  notesSchema,
} from "@palladian/notes-core";
import { blockIdPlugin } from "@palladian/notes-core/ids";
import { collab, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { history, undo } from "prosemirror-history";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { ReplaceStep, Step } from "prosemirror-transform";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AttachmentCache } from "../../src/attachment-cache";
import { setFileWrites } from "../../src/file-capability";
import {
  AttachmentReadError,
  displayType,
  liveAttachmentService,
  readAttachment,
  uploadRefusal,
  UploadError,
  type AttachmentService,
} from "../../src/attachments";
import {
  addUploads,
  insertUpload,
  removeUpload,
  unsentObjects,
  uploadedNode,
  uploadMarks,
  uploadPoint,
  uploadsPlugin,
} from "../../src/editor-attachments";
import type { LiveController } from "../../src/live";
import { formatSize, typeLabel } from "../../src/attachment-views";
import { ConvexError } from "convex/values";

const { paragraph, image, bullet_list, list_item } = notesSchema.nodes;
const OBJECT_A = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4a";
const OBJECT_B = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4b";

const para = (text: string, id = text.toLowerCase().replace(/\W/g, "")) =>
  paragraph!.create({ id }, text ? notesSchema.text(text) : null);
const docOf = (...blocks: ProseMirrorNode[]) =>
  notesSchema.node("doc", null, blocks);

/** An editor state bound like a live note (collab), with upload marks. */
function editorState(doc: ProseMirrorNode) {
  return EditorState.create({
    schema: notesSchema,
    doc,
    plugins: [
      collab({ version: 0, clientID: "me" }),
      blockIdPlugin((tr) => tr.getMeta("rebased") !== undefined),
      history(),
      uploadsPlugin(() => null),
    ],
  });
}
/** The top-level blocks as text, or `image:<object>`. */
const blocks = (doc: ProseMirrorNode) =>
  doc.content.content.map((node) =>
    node.type === image
      ? `image:${String(node.attrs.src).slice(11)}`
      : node.textContent,
  );
const grant = (
  objectId: string,
  name = "photo.png",
  mimeType = "image/png",
) => ({
  objectId,
  state: "ready" as const,
  ticket: null,
  name,
  mimeType,
});
/** Find the position just after the block whose text is `text`. */
function after(doc: ProseMirrorNode, text: string) {
  let found = -1;
  doc.forEach((node, offset) => {
    if (node.textContent === text) found = offset + node.nodeSize;
  });
  return found;
}

describe("where uploads land", () => {
  const doc = docOf(
    para("Title"),
    para("First line."),
    para(""),
    para("Second line."),
  );

  test("after the caret's block, or before an empty block or one the caret starts", () => {
    const first = 7 + 1; // inside "First line."
    expect(uploadPoint(doc, first + 3)).toBe(after(doc, "First line."));
    expect(uploadPoint(doc, first)).toBe(7);
    const empty = after(doc, "First line.");
    expect(uploadPoint(doc, empty + 1)).toBe(empty);
  });

  test("never before the title line", () => {
    expect(uploadPoint(doc, 1)).toBe(7);
    expect(uploadPoint(docOf(para("")), 1)).toBe(2);
  });

  test("inside a list item, after its first paragraph", () => {
    const list = bullet_list!.create({ id: "list" }, [
      list_item!.create({ id: "item" }, [para("Item")]),
    ]);
    const withList = docOf(para("Title"), list);
    // The caret at the start of the item: a picture cannot come before the
    // item's paragraph, so it lands after it, inside the item.
    const point = uploadPoint(withList, 7 + 3);
    const $point = withList.resolve(point);
    expect($point.parent.type).toBe(list_item);
    expect($point.index()).toBe(1);
  });
});

describe("upload marks follow the note", () => {
  test("typing, Enter and a collaborator's step move the mark; the node lands there", () => {
    let state = editorState(
      docOf(para("Album"), para("First line."), para("Second line.")),
    );
    const point = uploadPoint(state.doc, 7 + 11);
    state = state.apply(addUploads(state, [{ id: "u1", pos: point, seq: 1 }]));
    // The marks are not content.
    expect(sendableSteps(state)).toBeNull();
    // Local typing after the mark, and Enter before it.
    state = state.apply(
      state.tr.insertText(" Typed.", after(state.doc, "Second line.") - 1),
    );
    state = state.apply(state.tr.split(8));
    // A collaborator's paragraph under the title, as the server relays it.
    const remote = new ReplaceStep(
      7,
      7,
      docOf(para("Shared", "shared")).slice(0, 8),
    );
    state = state.apply(receiveTransaction(state, [remote], ["them"]));
    const tr = insertUpload(state, "u1", uploadedNode(grant(OBJECT_A), 10));
    state = state.apply(tr!);
    expect(blocks(state.doc)).toEqual([
      "Album",
      "Shared",
      "",
      "First line.",
      `image:${OBJECT_A}`,
      "Second line. Typed.",
    ]);
    expect(uploadMarks(state)).toEqual([]);
    // Every unsent step is one the server accepts.
    let server = remote.apply(
      docOf(para("Album"), para("First line."), para("Second line.")),
    ).doc!;
    for (const step of sendableSteps(state)!.steps)
      server = applySafeStep(server, step);
    expect(blocks(server)).toEqual(blocks(state.doc));
    expect(attachmentIds(server)).toEqual([OBJECT_A]);
  });

  test("uploads begun together land in the order chosen, whichever finishes first", () => {
    let state = editorState(docOf(para("Album"), para("Line.")));
    const point = state.doc.content.size;
    state = state.apply(
      addUploads(state, [
        { id: "one", pos: point, seq: 1 },
        { id: "two", pos: point, seq: 2 },
        { id: "three", pos: point, seq: 3 },
      ]),
    );
    state = state.apply(
      insertUpload(state, "two", uploadedNode(grant(OBJECT_B), 1))!,
    );
    state = state.apply(
      insertUpload(
        state,
        "three",
        uploadedNode(grant(OBJECT_B.replace(/b$/, "c")), 1),
      )!,
    );
    state = state.apply(
      insertUpload(state, "one", uploadedNode(grant(OBJECT_A), 1))!,
    );
    expect(blocks(state.doc)).toEqual([
      "Album",
      "Line.",
      `image:${OBJECT_A}`,
      `image:${OBJECT_B}`,
      `image:${OBJECT_B.replace(/b$/, "c")}`,
    ]);
  });

  test("a mark whose surroundings were deleted still lands in the note", () => {
    let state = editorState(
      docOf(para("Album"), para("First line."), para("Second line.")),
    );
    state = state.apply(
      addUploads(state, [
        { id: "u1", pos: after(state.doc, "First line."), seq: 1 },
      ]),
    );
    state = state.apply(state.tr.delete(7, state.doc.content.size));
    state = state.apply(
      insertUpload(state, "u1", uploadedNode(grant(OBJECT_A), 1))!,
    );
    expect(blocks(state.doc)).toEqual(["Album", `image:${OBJECT_A}`]);
  });

  test("a mark that ends up inside a line splits it rather than failing", () => {
    let state = editorState(
      docOf(para("Album"), para("First"), para("Second")),
    );
    state = state.apply(
      addUploads(state, [{ id: "u1", pos: after(state.doc, "First"), seq: 1 }]),
    );
    // Joining the two lines puts the mark inside the joined line.
    const join = after(state.doc, "First");
    state = state.apply(state.tr.join(join));
    expect(
      state.doc.resolve(uploadMarks(state)[0]!.pos).parent.isTextblock,
    ).toBe(true);
    state = state.apply(
      insertUpload(state, "u1", uploadedNode(grant(OBJECT_A), 1))!,
    );
    expect(blocks(state.doc)).toEqual([
      "Album",
      "First",
      `image:${OBJECT_A}`,
      "Second",
    ]);
  });

  test("the insertion is its own undo step; Remove drops a mark with no change", () => {
    let state = editorState(docOf(para("Album"), para("Line.")));
    state = state.apply(
      state.tr.insertText(" More", after(state.doc, "Line.") - 1),
    );
    state = state.apply(
      addUploads(state, [
        { id: "u1", pos: state.doc.content.size, seq: 1 },
        { id: "u2", pos: 7, seq: 2 },
      ]),
    );
    state = state.apply(removeUpload(state, "u2"));
    expect(uploadMarks(state).map((mark) => mark.id)).toEqual(["u1"]);
    state = state.apply(
      insertUpload(state, "u1", uploadedNode(grant(OBJECT_A), 1))!,
    );
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(blocks(state.doc)).toEqual(["Album", "Line. More"]);
  });

  test("a finished upload of another type becomes a file block", () => {
    const node = uploadedNode(
      grant(OBJECT_A, "report.pdf", "application/pdf"),
      2048,
    );
    expect(node.type.name).toBe("file");
    expect(node.attrs).toMatchObject({
      objectId: OBJECT_A,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });
    expect(
      uploadedNode(grant(OBJECT_A, "a.svg", "image/svg+xml"), 1).type.name,
    ).toBe("file");
  });

  test("objects brought in by unsent steps are known until the server confirms them", () => {
    let state = editorState(docOf(para("Album")));
    state = state.apply(addUploads(state, [{ id: "u1", pos: 7, seq: 1 }]));
    state = state.apply(
      insertUpload(state, "u1", uploadedNode(grant(OBJECT_A), 1))!,
    );
    expect([...unsentObjects(state)]).toEqual([OBJECT_A]);
    const sendable = sendableSteps(state)!;
    state = state.apply(
      receiveTransaction(
        state,
        sendable.steps,
        sendable.steps.map(() => sendable.clientID),
      ),
    );
    expect([...unsentObjects(state)]).toEqual([]);
  });

  test("selecting a picture: the next upload lands after it", () => {
    const state = editorState(
      docOf(
        para("Album"),
        image!.create({ id: "pic", src: "attachment:" + OBJECT_A }),
        para("End"),
      ),
    );
    const selected = state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, 7)),
    );
    expect(uploadPoint(selected.doc, selected.selection.to)).toBe(8);
    const caret = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 9)),
    );
    expect(uploadPoint(caret.doc, caret.selection.to)).toBe(8);
  });
});

describe("labels", () => {
  test("sizes and types", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2_516_582)).toBe("2.4 MB");
    expect(formatSize(150 * 1024)).toBe("150 KB");
    expect(typeLabel("report.pdf", "application/pdf")).toBe("PDF");
    expect(typeLabel("notes.docx", "application/octet-stream")).toBe("DOCX");
    expect(typeLabel("README", "text/plain")).toBe("File");
  });
  test("only picture types keep their type as bytes in the page", () => {
    expect(displayType("image/png")).toBe("image/png");
    expect(displayType("text/html")).toBe("application/octet-stream");
    expect(displayType("image/svg+xml")).toBe("application/octet-stream");
  });
});

describe("reading through the Worker", () => {
  afterEach(() => vi.unstubAllGlobals());
  const service = (
    tokens: (string | null)[],
  ): AttachmentService & { asked: boolean[] } => {
    const asked: boolean[] = [];
    return {
      asked,
      accountId: "ada",
      connected: () => true,
      createUpload: () => Promise.reject(new Error("unused")),
      cancelUpload: () => Promise.resolve(),
      token: (refresh = false) => {
        asked.push(refresh);
        return Promise.resolve(tokens.shift() ?? null);
      },
      watchNoteObjects: () => () => undefined,
    };
  };
  const NOTE = "k1700000000000000000000000000note";

  test("the token goes in a header; a 401 asks for a new token once", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const answers = [
      new Response("", { status: 401 }),
      new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      seen.push({
        url,
        authorization: new Headers(init.headers).get("Authorization"),
      });
      return Promise.resolve(answers.shift()!);
    });
    const files = service(["old", "new"]);
    const blob = await readAttachment(files, NOTE, OBJECT_A);
    expect(seen).toEqual([
      { url: `/files/notes/${NOTE}/${OBJECT_A}`, authorization: "Bearer old" },
      { url: `/files/notes/${NOTE}/${OBJECT_A}`, authorization: "Bearer new" },
    ]);
    expect(files.asked).toEqual([false, true]);
    // HTML bytes are never handed to the page as HTML.
    expect(blob.type).toBe("application/octet-stream");
  });

  test("404 is unavailable, other failures are failed, no token is signed out", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("", { status: 404 })),
    );
    await expect(
      readAttachment(service(["t"]), NOTE, OBJECT_A),
    ).rejects.toMatchObject({ kind: "unavailable" });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("", { status: 503 })),
    );
    await expect(
      readAttachment(service(["t"]), NOTE, OBJECT_A),
    ).rejects.toMatchObject({ kind: "failed" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    await expect(
      readAttachment(service(["t"]), NOTE, OBJECT_A),
    ).rejects.toMatchObject({ kind: "failed" });
    await expect(
      readAttachment(service([null]), NOTE, OBJECT_A),
    ).rejects.toBeInstanceOf(AttachmentReadError);
    // IDs that are not server IDs never become a path.
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    await expect(
      readAttachment(service(["t"]), "local-123", OBJECT_A),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      readAttachment(service(["t"]), NOTE, "../x"),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetched).not.toHaveBeenCalled();
  });

  test("server refusals keep their message; anything else is a retryable failure", () => {
    const refusal = uploadRefusal(
      new ConvexError({
        code: "trashed",
        message: "Restore this note from Trash before adding files.",
      }),
    );
    expect(refusal).toMatchObject({
      message: "Restore this note from Trash before adding files.",
      retryable: true,
    });
    expect(uploadRefusal(new Error("x"))).toMatchObject({ retryable: true });
    const kept = new UploadError("Files can be at most 25 MB.", false);
    expect(uploadRefusal(kept)).toBe(kept);
  });
});

describe("the live service's token", () => {
  const jwt = (claims: Record<string, unknown>) =>
    `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
  function live(
    tokens: (string | null)[],
    state = { ready: true, accountId: "ada", connected: true },
  ) {
    let asks = 0;
    const controller = {
      getState: () => state,
      auth: {
        convex: {
          token: () => {
            asks++;
            return Promise.resolve({ data: { token: tokens.shift() ?? null } });
          },
        },
      },
      client: {},
    };
    return {
      controller: controller as unknown as LiveController,
      asks: () => asks,
      state,
    };
  }

  test("only a token for this account; kept until shortly before it expires", async () => {
    const later = Math.floor(Date.now() / 1000) + 900;
    const setup = live([
      jwt({ sub: "bob", exp: later }),
      jwt({ sub: "ada", exp: later }),
    ]);
    const service = liveAttachmentService(setup.controller, "ada");
    expect(await service.token()).toBeNull();
    const token = await service.token();
    expect(token).toContain(".");
    expect(await service.token()).toBe(token);
    expect(setup.asks()).toBe(2);
  });

  test("none while the account is not signed in to the server", async () => {
    const setup = live([jwt({ sub: "ada", exp: 9e9 })], {
      ready: false,
      accountId: "ada",
      connected: false,
    });
    const service = liveAttachmentService(setup.controller, "ada");
    expect(await service.token()).toBeNull();
    expect(setup.asks()).toBe(0);
    expect(service.connected()).toBe(false);
  });
});

describe("the byte cache (memory only)", () => {
  const bytes = (n: number) =>
    new Blob([new Uint8Array(n)], { type: "image/png" });
  const ada = { accountId: "ada", generation: 1 };
  afterEach(() => setFileWrites(false));
  const cache = (limit?: number) => {
    setFileWrites(true);
    const made = new AttachmentCache(limit);
    made.follow(ada);
    return made;
  };

  test("only the current account and session generation read and store", () => {
    const memory = cache();
    memory.store(memory.ticket(ada), OBJECT_A, bytes(4));
    expect(memory.read(memory.ticket(ada), OBJECT_A)?.size).toBe(4);
    expect(memory.ticket({ accountId: "bob", generation: 1 })).toBeNull();
    expect(memory.ticket({ accountId: "ada", generation: 2 })).toBeNull();
    memory.store(null, OBJECT_B, bytes(4));
    expect(memory.objects()).toEqual([OBJECT_A]);
  });

  test("Ada, then Bob, then Ada again in one page: none of Ada's earlier bytes", () => {
    const memory = cache();
    const first = memory.ticket(ada);
    memory.store(first, OBJECT_A, bytes(4));
    memory.follow({ accountId: "bob", generation: 2 });
    expect(memory.objects()).toEqual([]);
    memory.follow({ accountId: "ada", generation: 3 });
    const again = memory.ticket({ accountId: "ada", generation: 3 });
    expect(memory.read(again, OBJECT_A)).toBeNull();
    // A read begun in Ada's first session neither reads nor stores now.
    expect(memory.read(first, OBJECT_A)).toBeNull();
    memory.store(first, OBJECT_A, bytes(4));
    expect(memory.objects()).toEqual([]);
  });

  test("signing out, a revoked session and a clear end every ticket", () => {
    const memory = cache();
    const ticket = memory.ticket(ada);
    memory.store(ticket, OBJECT_A, bytes(4));
    memory.follow(null);
    expect(memory.objects()).toEqual([]);
    memory.follow(ada);
    memory.store(ticket, OBJECT_A, bytes(4));
    expect(memory.objects()).toEqual([]);
    const fresh = memory.ticket(ada);
    memory.store(fresh, OBJECT_A, bytes(4));
    memory.clear();
    expect(memory.read(fresh, OBJECT_A)).toBeNull();
  });

  test("files off: no tickets, and turning them off clears the app's bytes", async () => {
    const { attachmentCache } = await import("../../src/attachment-cache");
    setFileWrites(true);
    attachmentCache.follow(ada);
    attachmentCache.store(attachmentCache.ticket(ada), OBJECT_A, bytes(4));
    expect(attachmentCache.objects()).toEqual([OBJECT_A]);
    setFileWrites(false);
    expect(attachmentCache.objects()).toEqual([]);
    expect(attachmentCache.ticket(ada)).toBeNull();
  });

  test("R4-1: every clear tells its listeners at once, with the new scope in place, and ends live tickets", () => {
    const memory = cache();
    const seen: Array<{ live: boolean; bob: boolean }> = [];
    const ticket = memory.ticket(ada);
    const stop = memory.onClear(() =>
      seen.push({
        live: memory.live(ticket),
        bob: memory.ticket({ accountId: "bob", generation: 2 }) !== null,
      }),
    );
    expect(memory.live(ticket)).toBe(true);
    memory.clear();
    expect(seen).toEqual([{ live: false, bob: false }]);
    memory.follow({ accountId: "bob", generation: 2 });
    expect(seen[1]).toEqual({ live: false, bob: true });
    // No change of scope, no clear.
    memory.follow({ accountId: "bob", generation: 2 });
    expect(seen).toHaveLength(2);
    stop();
    memory.clear();
    expect(seen).toHaveLength(2);
  });

  test("least recently used bytes go first past the cap", () => {
    const memory = cache(250);
    const ticket = memory.ticket(ada);
    memory.store(ticket, "o1", bytes(100));
    memory.store(ticket, "o2", bytes(100));
    memory.read(ticket, "o1");
    memory.store(ticket, "o3", bytes(100));
    expect(memory.objects()).toEqual(["o1", "o3"]);
    expect(memory.size()).toBe(200);
    // Anything larger than an upload can be is never kept.
    memory.store(
      ticket,
      "huge",
      new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]),
    );
    expect(memory.objects()).not.toContain("huge");
  });
});

describe("the server's rules", () => {
  test("a step bringing in an object is recorded by the server's own rules", () => {
    // The insertion step is an ordinary, valid step (applySafeStep), so the
    // server records the uploader's reference with it.
    const doc = docOf(para("Album"));
    const step = Step.fromJSON(notesSchema, {
      stepType: "replace",
      from: 7,
      to: 7,
      slice: { content: [uploadedNode(grant(OBJECT_A), 1).toJSON()] },
    });
    expect(attachmentIds(applySafeStep(doc, step))).toEqual([OBJECT_A]);
  });
});
