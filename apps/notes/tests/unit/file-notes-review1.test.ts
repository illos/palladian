import { describe, expect, test } from "vitest";
import { notesSchema } from "@palladian/notes-core/schema";
import { fileNoteBlock } from "../../src/editor-file-notes";
import { fileNoteFile } from "../../src/file-notes";

// Review round 1 of B4 (F5): the note list (stored JSON) and the editor
// (ProseMirror) tell file notes apart by the same rule.
const file = {
  type: "file",
  attrs: {
    objectId: "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 2_516_582,
  },
};

describe("file notes, review round 1", () => {
  test("F5: the list and the editor agree on every block a note can start with", () => {
    const textblocks = Object.values(notesSchema.nodes).filter(
      (type) => type.isTextblock,
    );
    // Every block a note can start with, apart from files and images.
    const blocks = Object.values(notesSchema.nodes).filter(
      (type) =>
        !!notesSchema.topNodeType.contentMatch.matchType(type) &&
        type.name !== "file" &&
        type.name !== "image",
    );
    expect(blocks.length).toBeGreaterThan(textblocks.length);
    for (const type of blocks) {
      const first = type.isTextblock
        ? type.create(
            null,
            type.name === "code_block" ? [] : notesSchema.text("Title"),
          )
        : type.createAndFill();
      if (!first) continue;
      const node = notesSchema.node("doc", null, [
        first,
        notesSchema.nodeFromJSON(file),
      ]);
      const json: unknown = node.toJSON();
      // A code block title (Mono) is a title like any other.
      expect([type.name, fileNoteBlock(node) !== null]).toEqual([
        type.name,
        type.isTextblock,
      ]);
      expect([type.name, fileNoteFile(json) !== null]).toEqual([
        type.name,
        type.isTextblock,
      ]);
    }
  });
});
