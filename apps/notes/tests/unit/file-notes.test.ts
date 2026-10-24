import { describe, expect, test } from "vitest";
import { notesSchema } from "@palladian/notes-core/schema";
import {
  fileNoteFile,
  fileNoteLabel,
  fileNoteOf,
  fileNoteRest,
  fileNoteStart,
  fileTitle,
} from "../../src/file-notes";
import { fileNoteBlock } from "../../src/editor-file-notes";
import {
  buildMatches,
  findPageMatches,
  pagePlainText,
  splitItemForRender,
  type PdfTextItem,
} from "../../src/pdf-search";

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const OTHER = "m57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const title = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const text = title;
const file = (objectId = OBJECT, name = "report.pdf") => ({
  type: "file",
  attrs: { objectId, name, mimeType: "application/pdf", size: 2_516_582 },
});
const image = (src = `attachment:${OBJECT}`, alt = "photo.png") => ({
  type: "image",
  attrs: { src, alt, title: null, width: null },
});
const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("file notes (plan 08 B4)", () => {
  test("a title line, one uploaded file and optional text is a file note", () => {
    expect(fileNoteFile(doc(title("report.pdf"), file()))).toEqual({
      kind: "file",
      objectId: OBJECT,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 2_516_582,
    });
    expect(
      fileNoteFile(doc(title("Trip"), image(), text("Notes."), text("More."))),
    ).toEqual({
      kind: "image",
      objectId: OBJECT,
      name: "photo.png",
      mimeType: "",
      size: null,
    });
    // A heading as the title, and a renamed title, still count.
    expect(
      fileNoteFile(
        doc({ type: "heading", attrs: { level: 1 }, content: [] }, file()),
      ),
    ).not.toBeNull();
  });

  test("anything else is an ordinary note", () => {
    // No title line, the file not second, a second file anywhere.
    expect(fileNoteFile(doc(file()))).toBeNull();
    expect(fileNoteFile(doc(title("A"), text("B"), file()))).toBeNull();
    expect(fileNoteFile(doc(title("A"), file(), file(OTHER)))).toBeNull();
    expect(
      fileNoteFile(
        doc(title("A"), file(), {
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [text("x"), image(`attachment:${OTHER}`)],
            },
          ],
        }),
      ),
    ).toBeNull();
    // Web images and sources that name no object are not uploads.
    expect(
      fileNoteFile(doc(title("A"), image("https://example.com/a.png"))),
    ).toBeNull();
    expect(
      fileNoteFile(doc(title("A"), image("attachment:Not-An-Id"))),
    ).toBeNull();
    expect(fileNoteFile(doc(title("A"), file("short")))).toBeNull();
    // A list is not a title line.
    expect(
      fileNoteFile(doc({ type: "bullet_list", content: [] }, file())),
    ).toBeNull();
    expect(fileNoteOf("not json")).toBeNull();
    expect(
      fileNoteOf(JSON.stringify(doc(title("report.pdf"), file()))),
    ).not.toBeNull();
  });

  test("the editor's rule matches the list's, on ProseMirror documents", () => {
    const cases = [
      doc(title("report.pdf"), file(), text("Notes.")),
      doc(title("Trip"), image()),
      doc(title("A"), file(), file(OTHER)),
      doc(title("A"), text("B"), file()),
      doc(title("A"), image("https://example.com/a.png")),
      doc(title("Just text"), text("More")),
    ];
    for (const json of cases) {
      const node = notesSchema.nodeFromJSON(json);
      const block = fileNoteBlock(node);
      expect(block !== null).toBe(fileNoteFile(json) !== null);
      if (block) {
        expect(block.pos).toBe(node.child(0).nodeSize);
        expect(node.nodeAt(block.pos)).toBe(block.node);
      }
    }
  });

  test("labels: type and size; images by their name", () => {
    const pdf = fileNoteFile(doc(title("x"), file()))!;
    expect(fileNoteLabel(pdf)).toBe("PDF · 2.4 MB");
    const photo = fileNoteFile(doc(title("x"), image()))!;
    expect(fileNoteLabel(photo)).toBe("PNG");
    // The size of the bytes this page holds, when it holds them.
    expect(fileNoteLabel(photo, 12 * 1024)).toBe("PNG · 12 KB");
    const unnamed = fileNoteFile(
      doc(title("x"), image(`attachment:${OBJECT}`, "")),
    )!;
    expect(fileNoteLabel(unnamed)).toBe("Image");
  });

  test("the list shows the text after the file's name", () => {
    const pdf = fileNoteFile(doc(title("x"), file()))!;
    expect(fileNoteRest("report.pdf", pdf)).toBe("");
    expect(fileNoteRest("report.pdf Read before Monday.", pdf)).toBe(
      "Read before Monday.",
    );
    // Cut short inside a long name, or spaces collapsed.
    expect(fileNoteRest("repo", pdf)).toBe("");
    const spaced = fileNoteFile(doc(title("x"), file(OBJECT, "a  b.pdf")))!;
    expect(fileNoteRest("a b.pdf more", spaced)).toBe("more");
    expect(fileNoteRest("Something else", pdf)).toBe("Something else");
  });

  test("a new file note's title is the file's name; files no upload takes make no note", () => {
    const made = fileNoteStart(
      new File(["%PDF"], "  Q3\treport.pdf ", { type: "application/pdf" }),
    );
    expect(made).toEqual({
      title: "Q3 report.pdf",
      document: JSON.stringify(doc(title("Q3 report.pdf"))),
    });
    expect(fileTitle({ name: "", type: "image/png" })).toBe("image");
    expect(fileTitle({ name: " ", type: "" })).toBe("file");
    expect(fileNoteStart(new File([], "empty.txt"))).toEqual({
      refused: "This file is empty.",
    });
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.bin");
    expect(fileNoteStart(big)).toEqual({
      refused: "Files can be at most 25 MB.",
    });
  });
});

describe("PDF search (B4, Deltos pdfSearch)", () => {
  const run = (str: string, left = 0): PdfTextItem => ({
    str,
    left,
    top: 0,
    width: str.length * 5,
    height: 10,
  });

  test("matches are found across runs, case-insensitively, in page order", () => {
    const pages = [
      { items: [run("The Needle "), run("is here")] },
      null,
      { items: [run("needle"), run("le and need"), run("le")] },
    ];
    expect(buildMatches(pages, "  NEEDLE ")).toEqual([
      { pageIndex: 0, charStart: 4, charEnd: 10 },
      { pageIndex: 2, charStart: 0, charEnd: 6 },
      { pageIndex: 2, charStart: 13, charEnd: 19 },
    ]);
    expect(buildMatches(pages, "   ")).toEqual([]);
    expect(findPageMatches([run("aaaa")], "aa")).toEqual([
      { charStart: 0, charEnd: 2 },
      { charStart: 2, charEnd: 4 },
    ]);
    expect(pagePlainText([run("ab"), run("cd")]).itemStarts).toEqual([0, 2]);
  });

  test("runs split into plain, match and active parts; markup stays text", () => {
    const item = run("<b>needle</b>");
    expect(
      splitItemForRender(item, 0, [{ charStart: 3, charEnd: 9 }], {
        charStart: 3,
        charEnd: 9,
      }),
    ).toEqual([
      { text: "<b>", kind: "plain" },
      { text: "needle", kind: "active" },
      { text: "</b>", kind: "plain" },
    ]);
    // A match that starts in the run before covers only this run's part.
    expect(
      splitItemForRender(run("dle!"), 10, [{ charStart: 7, charEnd: 13 }]),
    ).toEqual([
      { text: "dle", kind: "match" },
      { text: "!", kind: "plain" },
    ]);
  });
});
