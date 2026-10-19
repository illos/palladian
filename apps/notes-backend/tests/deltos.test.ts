import { describe, expect, test } from "vitest";
import { deltosToDoc, type DeltosNote } from "../convex/deltos";
import { normalizeNewDoc } from "../convex/documents";

type Segment = Record<string, unknown> & { text: string };
type Block = {
  id: string;
  type: string;
  content: Record<string, unknown>;
  children: Block[];
};

let next = 0;
function id() {
  next += 1;
  return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
}
function block(
  type: string,
  content: Record<string, unknown> = {},
  children: Block[] = [],
): Block {
  return { id: id(), type, content, children };
}
const seg = (text: string, marks: Record<string, unknown> = {}): Segment => ({
  text,
  ...marks,
});
const para = (...segments: Segment[]) => block("paragraph", { segments });

function convert(blocks: Block[], extra: Partial<DeltosNote> = {}) {
  const result = deltosToDoc({
    title: "",
    body: JSON.stringify(blocks),
    fileNote: false,
    fileExtract: null,
    ...extra,
  });
  // Every converted note must pass the creation path's own validation.
  normalizeNewDoc(JSON.stringify(result.doc.toJSON()));
  return { json: result.doc.toJSON(), warnings: result.warnings };
}

describe("Deltos conversion", () => {
  test("maps marks, keeping inline code exclusive and links safe", () => {
    const { json, warnings } = convert([
      para(
        seg("b", { bold: true }),
        seg("i", { italic: true }),
        seg("s", { strike: true }),
        seg("c", { code: true, bold: true }),
        seg("l", { link: "https://example.com/a", code: true, bold: true }),
        seg("u", { underline: true, highlight: true }),
        seg("j", { link: "javascript:void(0)" }),
        seg("r", { link: "./picture.jpg" }),
      ),
    ]);
    const marks = json.content[0].content.map(
      (node: { text: string; marks?: { type: string; attrs?: object }[] }) => [
        node.text,
        (node.marks ?? []).map((m) => m.type),
      ],
    );
    expect(marks).toEqual([
      ["b", ["strong"]],
      ["i", ["em"]],
      ["s", ["strike"]],
      ["c", ["code"]],
      ["l", ["link", "strong"]],
      // Neighbouring text with the same (no) marks is one text node.
      ["ujr", []],
    ]);
    expect(json.content[0].content[4].marks[0].attrs.href).toBe(
      "https://example.com/a",
    );
    expect(warnings).toEqual({
      "inline code inside a link dropped": 1,
      "underline dropped": 1,
      "highlight dropped": 1,
      "link that is not http, https or mailto kept as text": 2,
    });
  });

  test("keeps line breaks and formula sources", () => {
    const { json, warnings } = convert([
      para(seg("one\ntwo"), seg("2+2", { formula: { kind: "math" } })),
    ]);
    expect(
      json.content[0].content.map((n: { type: string }) => n.type),
    ).toEqual(["text", "hard_break", "text"]);
    expect(json.content[0].content[2].text).toBe("two2+2");
    expect(warnings).toEqual({ "formula kept as its source text": 1 });
  });

  test("keeps block IDs and heading levels, raising deep headings to 3", () => {
    const h2 = block("heading", { level: 2, segments: [seg("Two")] });
    const h5 = block("heading", { level: 5, segments: [seg("Five")] });
    const { json, warnings } = convert([h2, h5]);
    expect(json.content.map((n: { attrs: object }) => n.attrs)).toEqual([
      { id: h2.id, level: 2 },
      { id: h5.id, level: 3 },
    ]);
    expect(warnings).toEqual({ "heading below level 3 raised to level 3": 1 });
  });

  test("groups to-dos into checklists and splits mixed lists", () => {
    const todo = (text: string, checked: boolean) =>
      block("todo", { checked, segments: [seg(text)] });
    const nested = block("list", { ordered: true }, [
      block("item", { segments: [seg("inner")] }),
    ]);
    const list = block("list", { ordered: false }, [
      block("item", { segments: [seg("a")] }, [nested]),
      todo("t1", true),
      todo("t2", false),
      block("item", { segments: [seg("b")] }),
    ]);
    const { json, warnings } = convert([
      todo("top1", false),
      todo("top2", true),
      list,
    ]);
    expect(json.content.map((n: { type: string }) => n.type)).toEqual([
      "task_list",
      "bullet_list",
      "task_list",
      "bullet_list",
    ]);
    expect(
      json.content[0].content.map(
        (n: { attrs: { checked: boolean } }) => n.attrs.checked,
      ),
    ).toEqual([false, true]);
    // Only the first list from a split Deltos list keeps the Deltos block ID.
    expect(json.content[1].attrs.id).toBe(list.id);
    expect(json.content[2].attrs.id).toBeNull();
    const firstItem = json.content[1].content[0];
    expect(firstItem.content.map((n: { type: string }) => n.type)).toEqual([
      "paragraph",
      "ordered_list",
    ]);
    expect(firstItem.content[1].attrs.id).toBe(nested.id);
    expect(warnings).toEqual({});
  });

  test("converts code, dividers, quotes, attachments and link cards", () => {
    const attachment = block("attachment", {
      name: "Report.pdf",
      hash: "abc",
      mime: "application/pdf",
      size: 10,
    });
    const { json, warnings } = convert([
      block("code", { code: "let a = 1;", language: "ts" }),
      block("code", { code: "x", language: "not a label" }),
      block("divider"),
      block("quote", { segments: [seg("q1")] }, [para(seg("q2"))]),
      attachment,
      block("link_card", { url: "https://example.com", title: "Example" }),
      block("link_card", { url: "ftp://example.com", title: "" }),
    ]);
    expect(json.content.map((n: { type: string }) => n.type)).toEqual([
      "code_block",
      "code_block",
      "horizontal_rule",
      "blockquote",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(json.content[0].attrs.language).toBe("ts");
    expect(json.content[0].content[0].text).toBe("let a = 1;");
    expect(json.content[1].attrs.language).toBe("");
    expect(json.content[3].content).toHaveLength(2);
    expect(json.content[4].attrs.id).toBe(attachment.id);
    expect(json.content[4].content[0].text).toBe(
      "📎 Report.pdf (file to be added)",
    );
    expect(json.content[5].content[0].marks[0].attrs.href).toBe(
      "https://example.com",
    );
    expect(json.content[6].content[0].marks).toBeUndefined();
    expect(warnings).toEqual({
      "code language label dropped": 1,
      "attachment to bring over with files": 1,
      "link card kept as a link": 2,
    });
  });

  test("keeps the text of unknown blocks and skips empty ones", () => {
    const { json, warnings } = convert([
      block("callout", { segments: [seg("kept")] }),
      block("embed", { url: "x" }, [para(seg("child"))]),
    ]);
    expect(
      json.content.map(
        (n: { content: { text: string }[] }) => n.content[0]?.text,
      ),
    ).toEqual(["kept", "child"]);
    expect(warnings).toEqual({
      '"callout" block kept as text': 1,
      '"embed" block skipped': 1,
    });
  });

  test("puts the title first unless the body already starts with it", () => {
    const added = convert([para(seg("Body"))], { title: "  My   title " });
    expect(added.json.content[0]).toMatchObject({
      type: "heading",
      attrs: { level: 1 },
      content: [{ text: "My title" }],
    });
    const kept = convert(
      [block("heading", { level: 1, segments: [seg("Same")] }), para(seg("x"))],
      { title: "Same" },
    );
    expect(kept.json.content).toHaveLength(2);
    expect(convert([], { title: "" }).json.content).toEqual([
      { type: "paragraph", attrs: { id: null } },
    ]);
  });

  test("appends a file note's extracted text after its placeholder", () => {
    const { json } = convert([block("attachment", { name: "Scan.pdf" })], {
      title: "Scan.pdf",
      fileNote: true,
      fileExtract: "Page one\nline two\n\n\nPage two",
    });
    expect(json.content.map((n: { type: string }) => n.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(json.content[2].content[0]).toMatchObject({
      text: "Text extracted from the file:",
      marks: [{ type: "em" }],
    });
    expect(json.content[4].content[0].text).toBe("Page two");
  });

  test("rejects a body that is not JSON", () => {
    expect(() =>
      deltosToDoc({ title: "", body: "{", fileNote: false, fileExtract: null }),
    ).toThrow(SyntaxError);
  });
});
