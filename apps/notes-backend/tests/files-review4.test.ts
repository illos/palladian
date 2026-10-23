/// <reference types="vite/client" />
// Regression tests for review round 4 of B1+B2
// (docs/reviews/notes-files-backend-round4-astra-review.md).
import { notesSchema } from "@palladian/notes-core";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  createNote,
  docJson,
  human,
  image,
  replaceAll,
  setup,
  upload,
  type As,
} from "./files-harness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  process.env.FILES_WRITES_ENABLED = "true";
});

const off = () => {
  process.env.FILES_WRITES_ENABLED = "false";
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

describe("R4-2: turning files off later keeps existing attachments editable", () => {
  async function noteWithFiles() {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Album");
    const photo = await upload(t, ada.as, { noteId }, "photo");
    const pdf = await upload(t, ada.as, { noteId }, "pdf");
    const other = await upload(t, ada.as, { noteId }, "other");
    const markdown = [
      "Album",
      "Some text.",
      `![photo](attachment:${photo}){width=320}`,
      `[report.pdf](attachment:${pdf}){type=application/pdf size=3}`,
      "![web](https://example.com/w.png){width=200}",
    ].join("\n\n");
    await replaceAll(ada.as, noteId, markdown);
    return { t, ada, noteId, photo, pdf, other, markdown };
  }

  test("text-only edits through push, replace_all and replace_text succeed", async () => {
    const { ada, noteId, markdown } = await noteWithFiles();
    off();
    // Typing.
    await push(ada.as, noteId, (tr) => tr.insert(6, notesSchema.text(" More")));
    // replace_all keeping the identical file block and sized images.
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    await ada.as.mutation(api.notes.edit, {
      noteId,
      expectedRevision: content.revision,
      edits: [
        {
          type: "replace_all",
          markdown: markdown.replace("Some text.", "Other text."),
        },
      ],
    });
    // replace_text.
    await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [
        { type: "replace_text", old_text: "Other text.", new_text: "Final." },
      ],
    });
    const read = await ada.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(read.markdown).toContain("Final.");
    expect(read.markdown).toContain("{width=320}");
    expect(read.markdown).toContain("[report.pdf]");
    // Removing an attachment works too.
    const now = (await ada.as.query(api.notes.content, { noteId }))!;
    await ada.as.mutation(api.notes.edit, {
      noteId,
      expectedRevision: now.revision,
      edits: [{ type: "replace_all", markdown: "Album\n\nFinal." }],
    });
  });

  test("new file features stay refused: another object, a new width", async () => {
    const { ada, noteId, other, markdown } = await noteWithFiles();
    off();
    const refused = /not enabled/;
    await expect(
      ada.as.mutation(api.notes.edit, {
        noteId,
        edits: [{ type: "append", markdown: image(other) }],
      }),
    ).rejects.toThrow(refused);
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    await expect(
      ada.as.mutation(api.notes.edit, {
        noteId,
        expectedRevision: content.revision,
        edits: [
          {
            type: "replace_all",
            markdown: markdown.replace("{width=320}", "{width=400}"),
          },
        ],
      }),
    ).rejects.toThrow(refused);
    // An existing image resized through a step.
    const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
    let imagePos = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === "image" && imagePos < 0) imagePos = offset;
    });
    await expect(
      push(ada.as, noteId, (tr) => tr.setNodeAttribute(imagePos, "width", 100)),
    ).rejects.toThrow(refused);
  });

  test("copies keep what their source has; a copy with no source does not", async () => {
    const { ada, noteId, markdown } = await noteWithFiles();
    off();
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    // A duplicate or conflict copy naming its source.
    const copy = await ada.as.mutation(api.notes.create, {
      clientKey: "copy",
      doc: content.doc,
      sourceNoteId: noteId,
    });
    expect(copy.replayed).toBe(false);
    await expect(
      ada.as.mutation(api.notes.create, {
        clientKey: "loose-copy",
        doc: content.doc,
      }),
    ).rejects.toThrow(/not enabled/);
    await expect(
      ada.as.mutation(api.notes.createFromMarkdown, { markdown }),
    ).rejects.toThrow(/not enabled/);
    expect(
      await ada.as.mutation(api.notes.createFromMarkdown, {
        markdown,
        sourceNoteIds: [noteId],
      }),
    ).toMatchObject({ replayed: false });
    // Plain notes are unaffected.
    await ada.as.mutation(api.notes.create, {
      clientKey: "plain",
      doc: docJson("Plain"),
    });
  });
});

describe("R4-1: the app can ask whether files are on", () => {
  test("files.capabilities follows the switch; signed out is always off", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    expect(await ada.as.query(api.files.capabilities, {})).toEqual({
      writes: true,
    });
    expect(await t.query(api.files.capabilities, {})).toEqual({
      writes: false,
    });
    off();
    expect(await ada.as.query(api.files.capabilities, {})).toEqual({
      writes: false,
    });
  });
});
