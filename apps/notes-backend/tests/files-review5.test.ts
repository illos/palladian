/// <reference types="vite/client" />
// Regression tests for review round 5 of B1+B2
// (docs/reviews/notes-files-backend-round5-astra-review.md).
import { notesSchema } from "@palladian/notes-core";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  agent,
  createNote,
  human,
  setup,
  type As,
  type T,
} from "./files-harness";

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const refused = /not enabled/;

beforeEach(() => {
  vi.useFakeTimers();
  // Files stay off throughout, as on a deployment that never enabled them.
  process.env.FILES_WRITES_ENABLED = "false";
});
afterEach(() => {
  vi.useRealTimers();
  process.env.FILES_WRITES_ENABLED = "true";
});

const paragraph = (id: string, text: string) => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});

/**
 * Store a document directly as the note's current content and revision 0,
 * as content written before B2 (or while files were on) would be.
 */
async function store(t: T, noteId: Id<"notes">, doc: unknown) {
  await t.run(async (ctx) => {
    const content = await ctx.db
      .query("noteContent")
      .withIndex("by_note", (q) => q.eq("noteId", noteId))
      .unique();
    await ctx.db.patch(content!._id, { doc: JSON.stringify(doc) });
    const checkpoint = await ctx.db
      .query("noteCheckpoints")
      .withIndex("by_note_and_revision", (q) =>
        q.eq("noteId", noteId).eq("revision", 0),
      )
      .unique();
    await ctx.db.patch(checkpoint!._id, { doc: JSON.stringify(doc) });
  });
}

/** An image as `0042ef8`'s schema stored it: no width attribute at all. */
const preB2Image = {
  type: "doc",
  content: [
    paragraph("p1", "Old note"),
    {
      type: "image",
      attrs: {
        id: "i1",
        src: `attachment:${OBJECT}`,
        alt: "photo",
        title: null,
      },
    },
  ],
};

const fileBlock = {
  type: "doc",
  content: [
    paragraph("p1", "Note"),
    {
      type: "file",
      attrs: {
        id: "f1",
        objectId: OBJECT,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 3,
      },
    },
  ],
};

async function push(
  as: As,
  noteId: Id<"notes">,
  edit: (tr: Transform) => void,
) {
  const content = (await as.query(api.notes.content, { noteId }))!;
  const tr = new Transform(notesSchema.nodeFromJSON(JSON.parse(content.doc)));
  edit(tr);
  return await as.mutation(api.notes.push, {
    noteId,
    revision: content.revision,
    steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
    clientId: "c1",
  });
}

describe("R5-1: an image never allows a file block for its object, or the reverse", () => {
  test("a pre-B2 attachment image does not let a file block for its ID in", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Old note");
    await store(t, noteId, preB2Image);
    // The reviewer's case: append a file block referencing the image's ID.
    await expect(
      ada.as.mutation(api.notes.edit, {
        noteId,
        edits: [
          {
            type: "append",
            markdown: `[report.pdf](attachment:${OBJECT}){type=application/pdf size=3}`,
          },
        ],
      }),
    ).rejects.toThrow(refused);
    // The same through a client push.
    await expect(
      push(ada.as, noteId, (tr) =>
        tr.insert(
          tr.doc.content.size,
          notesSchema.nodes.file!.create({
            objectId: OBJECT,
            name: "report.pdf",
            mimeType: "application/pdf",
            size: 3,
          }),
        ),
      ),
    ).rejects.toThrow(refused);
    // The note is as it was; it still edits, and another copy of the image
    // (an object it already shows as an image) is accepted.
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    expect(content.doc).not.toContain('"file"');
    await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [
        { type: "replace_text", old_text: "Old note", new_text: "Old notes" },
        { type: "append", markdown: `![again](attachment:${OBJECT})` },
      ],
    });
  });

  test("a file block does not let an image of its object in", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    await store(t, noteId, fileBlock);
    await expect(
      ada.as.mutation(api.notes.edit, {
        noteId,
        edits: [{ type: "append", markdown: `![x](attachment:${OBJECT})` }],
      }),
    ).rejects.toThrow(refused);
    // An image whose source is changed to the object, step by step.
    await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [
        { type: "append", markdown: "![web](https://example.com/w.png)" },
      ],
    });
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
    let imagePos = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === "image") imagePos = offset;
    });
    await expect(
      push(ada.as, noteId, (tr) =>
        tr.setNodeAttribute(imagePos, "src", `attachment:${OBJECT}`),
      ),
    ).rejects.toThrow(refused);
  });

  test("named-source copies compare by kind too", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const source = await createNote(ada.as, "Old note");
    await store(t, source, preB2Image);
    await expect(
      ada.as.mutation(api.notes.createFromMarkdown, {
        markdown: `Copy\n\n[report.pdf](attachment:${OBJECT}){type=application/pdf size=3}`,
        sourceNoteIds: [source],
      }),
    ).rejects.toThrow(refused);
    const content = (await ada.as.query(api.notes.content, {
      noteId: source,
    }))!;
    // A duplicate of the note itself keeps its image.
    const copy = await ada.as.mutation(api.notes.create, {
      clientKey: "copy",
      doc: content.doc,
      sourceNoteId: source,
    });
    expect(copy.replayed).toBe(false);
    expect(
      await ada.as.mutation(api.notes.createFromMarkdown, {
        markdown: `Copy\n\n![photo](attachment:${OBJECT})`,
        sourceNoteIds: [source],
      }),
    ).toMatchObject({ replayed: false });
  });
});

describe("files.capabilities", () => {
  test("any signed-in principal reads the one switch, agents included", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const claude = await agent(t, ada.id);
    for (const as of [ada.as, claude.as])
      expect(await as.query(api.files.capabilities, {})).toEqual({
        writes: false,
      });
    process.env.FILES_WRITES_ENABLED = "true";
    for (const as of [ada.as, claude.as])
      expect(await as.query(api.files.capabilities, {})).toEqual({
        writes: true,
      });
  });
});
