import assert from "node:assert/strict";
import { test } from "node:test";
import { AttrStep, ReplaceStep, Transform } from "prosemirror-transform";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "prosemirror-model";
import {
  applyEdits,
  applySafeStep,
  assertSafeDocument,
  attachmentIds,
  attachmentObjectId,
  blockHash,
  deriveSummary,
  diffSteps,
  docToMarkdown,
  emptyDoc,
  markdownToDoc,
  notesSchema,
  outline,
  parseStoredDoc,
  plainText,
  UnsafeDocumentError,
} from "../src/index.ts";

const A = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const B = "0000000000000000000000010000objects"; // convex-test style ID
const node = notesSchema.nodes;

function doc(...blocks: ProseMirrorNode[]) {
  return notesSchema.topNodeType.create(null, blocks);
}
function file(attrs: Record<string, unknown>) {
  return node.file!.create({
    objectId: A,
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 24576,
    ...attrs,
  });
}
function stored(value: ProseMirrorNode) {
  return parseStoredDoc(JSON.stringify(value.toJSON()));
}
/** JSON without block IDs, for comparing parsed documents. */
function shape(value: ProseMirrorNode) {
  return JSON.stringify(value.toJSON(), (key, item) =>
    key === "id" ? undefined : item,
  );
}

test("attachment references accept only object IDs", () => {
  assert.equal(attachmentObjectId(`attachment:${A}`), A);
  assert.equal(attachmentObjectId(`attachment:${B}`), B);
  for (const bad of [
    "attachment:",
    "attachment:short",
    `attachment:${A.toUpperCase()}`,
    `attachment:${A}/x`,
    `attachment:${A}?a=1`,
    `attachment:../${A}`,
    ` attachment:${A}`,
    `Attachment:${A}`,
    `attachment:${"a".repeat(65)}`,
    `https://example.com/${A}`,
    null,
    42,
  ])
    assert.equal(attachmentObjectId(bad), null, String(bad));
});

test("an image's width round-trips through JSON and Markdown", () => {
  const image = node.image!.create({
    src: `attachment:${A}`,
    alt: "Chart",
    width: 480,
  });
  const value = doc(image);
  assert.equal(stored(value).firstChild!.attrs.width, 480);
  const markdown = docToMarkdown(value);
  assert.equal(markdown, `![Chart](attachment:${A}){width=480}`);
  const back = markdownToDoc(markdown);
  assert.equal(shape(back), shape(value));
  assert.equal(docToMarkdown(back), markdown);
  // Without a width the Markdown is plain.
  const natural = doc(node.image!.create({ src: `attachment:${A}` }));
  assert.equal(docToMarkdown(natural), `![](attachment:${A})`);
  assert.equal(
    markdownToDoc(docToMarkdown(natural)).firstChild!.attrs.width,
    null,
  );
});

test("invalid image widths stay literal text in Markdown", () => {
  for (const attribute of [
    "{width=8}",
    "{width=99999}",
    "{width=1.5}",
    "{width=480 height=2}",
    "{height=2}",
    "{width=480 width=500}",
  ]) {
    const parsed = markdownToDoc(`![x](attachment:${A})${attribute}`);
    const image = parsed.lastChild!;
    assert.equal(image.type.name, "image");
    assert.equal(image.attrs.width, null, attribute);
    assert.equal(parsed.firstChild!.textContent, attribute);
    assertSafeDocument(parsed);
  }
  // Text after a valid attribute block stays in the paragraph.
  const parsed = markdownToDoc(`![x](attachment:${A}){width=64} caption`);
  assert.equal(parsed.firstChild!.textContent.trim(), "caption");
  assert.equal(parsed.lastChild!.attrs.width, 64);
});

test("stored documents reject invalid image widths", () => {
  for (const width of [0, 31, 4097, 100.5, "200", -1]) {
    const value = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { id: "i1", src: `attachment:${A}`, width },
        },
      ],
    };
    assert.throws(
      () => parseStoredDoc(JSON.stringify(value)),
      UnsafeDocumentError,
      String(width),
    );
  }
});

test("a file block round-trips through JSON and Markdown", () => {
  const value = doc(
    node.paragraph!.create(null, notesSchema.text("Q3 report")),
    file({}),
    node.paragraph!.create(null, notesSchema.text("Notes about it.")),
  );
  stored(value);
  const markdown = docToMarkdown(value);
  assert.equal(
    markdown,
    `Q3 report\n\n[report.pdf](attachment:${A}){type=application/pdf size=24576}\n\nNotes about it.`,
  );
  const back = markdownToDoc(markdown);
  assert.equal(shape(back), shape(value));
  assertSafeDocument(back);
});

test("file names survive Markdown escaping", () => {
  for (const name of [
    "a [b] (c).pdf",
    "*star* _under_ `tick`.txt",
    "back\\slash.txt",
    "R&D.docx",
    "&amp; literal.txt",
    "&#169; 2026.txt",
    "#not a heading.md",
    "1. not a list.txt",
    "- dash.txt",
    "> quote.txt",
    "~~strike~~.txt",
    "ünïcödé 日本語 🗂️.pdf",
    "x".repeat(255),
  ]) {
    const value = doc(file({ name, mimeType: "", size: null }));
    stored(value);
    const back = markdownToDoc(docToMarkdown(value));
    assert.equal(back.childCount, 1, name);
    assert.equal(back.firstChild!.type.name, "file", name);
    assert.equal(back.firstChild!.attrs.name, name, name);
  }
});

test("file Markdown without attributes, and partial attributes", () => {
  const bare = markdownToDoc(`[notes.txt](attachment:${A})`).firstChild!;
  assert.deepEqual(
    { ...bare.attrs, id: null },
    { id: null, objectId: A, name: "notes.txt", mimeType: "", size: null },
  );
  const sized = markdownToDoc(`[a.bin](attachment:${A}){size=0}`).firstChild!;
  assert.equal(sized.attrs.size, 0);
  assert.equal(sized.attrs.mimeType, "");
  assert.equal(docToMarkdown(doc(sized)), `[a.bin](attachment:${A}){size=0}`);
  // An unknown or invalid attribute leaves the block bare and the text literal.
  const odd = markdownToDoc(
    `[a.bin](attachment:${A}){type=Application/PDF size=3}`,
  );
  assert.equal(odd.lastChild!.type.name, "file");
  assert.equal(odd.lastChild!.attrs.mimeType, "");
  assert.equal(odd.firstChild!.textContent, "{type=Application/PDF size=3}");
  // An empty label still makes a valid block.
  const unnamed = markdownToDoc(`[](attachment:${A})`).firstChild!;
  assert.equal(unnamed.attrs.name, "Attachment");
});

test("attachment links become file blocks wherever they appear", () => {
  const inline = markdownToDoc(`See [plan.pdf](attachment:${A}) for details.`);
  assert.deepEqual(
    [inline.child(0).type.name, inline.child(1).type.name],
    ["paragraph", "file"],
  );
  assert.equal(inline.child(0).textContent, "See  for details.");
  const listed = markdownToDoc(`- [x.pdf](attachment:${A})\n- second`);
  assertSafeDocument(listed);
  assert.deepEqual(attachmentIds(listed), [A]);
  const quoted = markdownToDoc(`> ![x](attachment:${B})`);
  assertSafeDocument(quoted);
  assert.deepEqual(attachmentIds(quoted), [B]);
  // A heading keeps the text only; images there no longer fail to parse.
  const heading = markdownToDoc(
    `# Title [a.pdf](attachment:${A}) ![pic](https://example.com/p.png)`,
  );
  assert.equal(heading.childCount, 1);
  assert.equal(heading.firstChild!.textContent, "Title a.pdf pic");
  // Ordinary and malformed attachment links are not files.
  const links = markdownToDoc(
    `[web](https://example.com) [bad](attachment:../etc) [up](attachment:${A.toUpperCase()})`,
  );
  assert.equal(links.childCount, 1);
  assert.deepEqual(attachmentIds(links), []);
  assert.equal(links.firstChild!.textContent, "web bad up");
});

test("stored documents reject invalid file blocks", async () => {
  const bad: Record<string, unknown>[] = [
    { objectId: "short" },
    { objectId: A.toUpperCase() },
    { objectId: `${A}/x` },
    { objectId: null },
    { name: "" },
    { name: " padded.pdf" },
    { name: "line\nbreak.pdf" },
    { name: "tab\t.pdf" },
    { name: "x".repeat(256) },
    { name: 7 },
    { mimeType: "application/PDF" },
    { mimeType: "text/html; charset=utf-8" },
    { mimeType: "nonsense" },
    { mimeType: null },
    { size: -1 },
    { size: 1.5 },
    { size: "12" },
    { size: 1e13 },
  ];
  for (const attrs of bad) {
    const value = {
      type: "doc",
      content: [
        {
          type: "file",
          attrs: {
            id: "f1",
            objectId: A,
            name: "a.pdf",
            mimeType: "application/pdf",
            size: 3,
            ...attrs,
          },
        },
      ],
    };
    assert.throws(
      () => parseStoredDoc(JSON.stringify(value)),
      UnsafeDocumentError,
      JSON.stringify(attrs),
    );
  }
  const image = JSON.stringify({
    type: "doc",
    content: [{ type: "image", attrs: { id: "i1", src: "attachment:../x" } }],
  });
  // New content is refused; a stored one is tolerated as legacy (review F7)
  // but names no object.
  const { parseSubmittedDoc } = await import("../src/index.ts");
  assert.throws(() => parseSubmittedDoc(image), UnsafeDocumentError);
  assert.deepEqual(attachmentIds(parseStoredDoc(image)), []);
  const notAnImage = JSON.stringify({
    type: "doc",
    content: [{ type: "image", attrs: { id: "i1", src: "javascript:x" } }],
  });
  assert.throws(() => parseStoredDoc(notAnImage), UnsafeDocumentError);
});

test("steps cannot introduce invalid attachments", () => {
  const start = stored(
    doc(node.paragraph!.create(null, notesSchema.text("x"))),
  );
  const badFile = node.file!.create({ objectId: "../../etc", name: "a" });
  assert.throws(
    () =>
      applySafeStep(
        start,
        new ReplaceStep(
          start.content.size,
          start.content.size,
          new Slice(Fragment.from(badFile), 0, 0),
        ),
      ),
    UnsafeDocumentError,
  );
  const withImage = stored(
    doc(node.image!.create({ id: "img1", src: `attachment:${A}` })),
  );
  assert.throws(
    () => applySafeStep(withImage, new AttrStep(0, "width", 5)),
    UnsafeDocumentError,
  );
  assert.throws(
    () => applySafeStep(withImage, new AttrStep(0, "src", "attachment:nope")),
    UnsafeDocumentError,
  );
  const resized = applySafeStep(withImage, new AttrStep(0, "width", 300));
  assert.equal(resized.firstChild!.attrs.width, 300);
  const withFile = stored(doc(file({ id: "f1" })));
  assert.throws(
    () => applySafeStep(withFile, new AttrStep(0, "name", "a\u0000b")),
    UnsafeDocumentError,
  );
});

test("attachmentIds lists each referenced object once, in order", () => {
  const value = markdownToDoc(
    [
      "Title",
      `![a](attachment:${A})`,
      "![web](https://example.com/x.png)",
      `> [b.pdf](attachment:${B})`,
      `- [again](attachment:${A})`,
    ].join("\n\n"),
  );
  assert.deepEqual(attachmentIds(value), [A, B]);
  assert.deepEqual(attachmentIds(value.content), [A, B]);
  assert.deepEqual(attachmentIds(emptyDoc()), []);
});

test("file names are searchable text and a file note's title is its first line", () => {
  const value = doc(
    node.paragraph!.create(null, notesSchema.text("report.pdf")),
    file({}),
    node.paragraph!.create(null, notesSchema.text("Read before Friday.")),
  );
  assert.equal(plainText(value), "report.pdf\nreport.pdf\nRead before Friday.");
  assert.deepEqual(deriveSummary(value), {
    title: "report.pdf",
    preview: "report.pdf Read before Friday.",
  });
});

test("agent edits keep file and image attributes they do not touch", () => {
  const value = stored(
    doc(
      node.paragraph!.create({ id: "p1" }, notesSchema.text("Intro")),
      node.image!.create({ id: "i1", src: `attachment:${B}`, width: 200 }),
      file({ id: "f1" }),
      node.paragraph!.create({ id: "p2" }, notesSchema.text("Outro")),
    ),
  );
  // replace_text spanning the attachments re-reads their Markdown.
  const tr = applyEdits(value, [
    {
      type: "replace_text",
      old_text: `Intro\n\n![](attachment:${B}){width=200}\n\n[report.pdf]`,
      new_text: `Start\n\n![](attachment:${B}){width=200}\n\n[report.pdf]`,
    },
  ]);
  const after = tr.doc;
  assert.equal(after.child(0).textContent, "Start");
  assert.equal(after.child(1).attrs.width, 200);
  assert.deepEqual(
    { ...after.child(2).attrs, id: null },
    {
      id: null,
      objectId: A,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 24576,
    },
  );
  // The outline shows the file's Markdown and a block hash for it.
  const entry = outline(after).find((e) => e.type === "file")!;
  assert.equal(
    entry.markdown,
    `[report.pdf](attachment:${A}){type=application/pdf size=24576}`,
  );
  assert.equal(entry.hash, blockHash(after.child(2)));
  // Agents insert files with Markdown.
  const appended = applyEdits(after, [
    { type: "append", markdown: `[more.zip](attachment:${B}){size=9}` },
  ]).doc;
  assert.equal(appended.lastChild!.type.name, "file");
  assert.deepEqual(attachmentIds(appended), [B, A]);
});

test("diffSteps reproduces attachment changes exactly", () => {
  const before = stored(
    doc(
      node.paragraph!.create({ id: "p1" }, notesSchema.text("a")),
      node.image!.create({ id: "i1", src: `attachment:${A}` }),
    ),
  );
  const after = stored(
    doc(
      node.paragraph!.create({ id: "p1" }, notesSchema.text("a")),
      node.image!.create({ id: "i1", src: `attachment:${A}`, width: 640 }),
      file({ id: "f1", objectId: B }),
    ),
  );
  const steps = diffSteps(before, after)!;
  assert.ok(steps.length > 0);
  let result = before;
  for (const step of steps) result = applySafeStep(result, step);
  assert.equal(shape(result), shape(after));
});

test("existing documents still parse: images without width, Deltos placeholders", () => {
  // An image stored before `width` existed.
  const legacy = {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: {
          id: "i1",
          src: "https://example.com/a.png",
          alt: "a",
          title: null,
        },
      },
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "📎 scan.pdf (file to be added)" }],
      },
    ],
  };
  const parsed = parseStoredDoc(JSON.stringify(legacy));
  assert.equal(parsed.firstChild!.attrs.width, null);
  assert.equal(
    docToMarkdown(parsed),
    "![a](https://example.com/a.png)\n\n📎 scan.pdf (file to be added)",
  );
  assert.deepEqual(attachmentIds(parsed), []);
  const tr = new Transform(parsed);
  assert.equal(tr.doc.childCount, 2);
});

test("the file block renders and parses through the DOM spec", () => {
  const spec = notesSchema.nodes.file!.spec;
  const block = file({ id: "f1" });
  const rendered = spec.toDOM!(block) as unknown as [
    string,
    Record<string, string>,
    string,
  ];
  assert.equal(rendered[0], "div");
  assert.deepEqual(rendered[1], {
    "data-block-id": "f1",
    "data-object-id": A,
    "data-name": "report.pdf",
    "data-mime-type": "application/pdf",
    "data-size": "24576",
  });
  assert.equal(rendered[2], "report.pdf");
  const element = (attrs: Record<string, string>) => ({
    getAttribute: (name: string) => attrs[name] ?? null,
  });
  const getAttrs = spec.parseDOM![0]!.getAttrs!;
  assert.deepEqual(getAttrs(element(rendered[1]) as unknown as HTMLElement), {
    id: "f1",
    objectId: A,
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 24576,
  });
  // Pasted HTML naming something other than an object is not a file block.
  assert.equal(
    getAttrs(
      element({
        "data-object-id": "javascript:alert(1)",
        "data-name": "x",
      }) as unknown as HTMLElement,
    ),
    false,
  );
});

// Review round 1 (docs/reviews/notes-files-backend-round1-astra-review.md).

test("F6: names and descriptions with autolinks round-trip", async () => {
  const names = [
    "contact <x@y.com>.pdf",
    "<https://example.com>.pdf",
    "see https://example.com now.pdf",
    "www.example.com notes.txt",
    "a@b.co.pdf",
    "x < y > z.txt",
    "<>.txt",
  ];
  for (const name of names) {
    const value = doc(file({ name, mimeType: "", size: null }));
    stored(value);
    const back = markdownToDoc(docToMarkdown(value));
    assert.equal(back.childCount, 1, name);
    assert.equal(back.firstChild!.attrs.name, name, name);
  }
  for (const alt of ["a <x@y.com>", "<https://example.com>", "a &amp; b"]) {
    const value = doc(node.image!.create({ src: `attachment:${A}`, alt }));
    const back = markdownToDoc(docToMarkdown(value));
    assert.equal(back.lastChild!.attrs.alt, alt, alt);
  }
  // Agent Markdown with a link inside an attachment label still parses.
  const nested = markdownToDoc(`[file <x@y.com> name](attachment:${A})`);
  assert.equal(nested.childCount, 1);
  assert.equal(nested.firstChild!.type.name, "file");
  assert.equal(nested.firstChild!.attrs.name, "file x@y.com name");
});

test("F7: stored documents keep legacy image sources; new content may not", async () => {
  const { parseSubmittedDoc, isLegacyImageSource } =
    await import("../src/index.ts");
  const legacy = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "x" }],
      },
      {
        type: "image",
        attrs: { id: "i1", src: " Attachment:Old/ID ", width: null },
      },
    ],
  });
  assert.ok(isLegacyImageSource(" Attachment:Old/ID "));
  assert.ok(!isLegacyImageSource("http://insecure.example/a.png"));
  const value = parseStoredDoc(legacy);
  assert.deepEqual(attachmentIds(value), []);
  assert.throws(() => parseSubmittedDoc(legacy), UnsafeDocumentError);
  // Editing elsewhere, or resizing it, keeps working ...
  const edited = applySafeStep(
    value,
    new ReplaceStep(
      2,
      2,
      new Slice(Fragment.from(notesSchema.text("y")), 0, 0),
    ),
  );
  const imagePos = edited.child(0).nodeSize;
  applySafeStep(edited, new AttrStep(imagePos, "width", 200));
  // ... but a new loose source is refused, as is inserting one.
  assert.throws(
    () => applySafeStep(edited, new AttrStep(imagePos, "src", "attachment:x")),
    UnsafeDocumentError,
  );
  assert.throws(
    () =>
      applySafeStep(
        edited,
        new ReplaceStep(
          edited.content.size,
          edited.content.size,
          new Slice(Fragment.from(edited.child(1)), 0, 0),
        ),
      ),
    UnsafeDocumentError,
  );
  // Agent edits on such a note work too.
  const tr = applyEdits(value, [{ type: "append", markdown: "More." }]);
  assert.equal(tr.doc.lastChild!.textContent, "More.");
});

test("F2: stepAttachmentIds names what each step brings in", async () => {
  const { stepAttachmentIds } = await import("../src/index.ts");
  const start = stored(doc(node.paragraph!.create({ id: "p1" })));
  const tr = new Transform(start);
  tr.insert(start.content.size, file({ id: "f1" }));
  tr.insert(
    tr.doc.content.size,
    node.image!.create({ id: "i1", src: `attachment:${B}` }),
  );
  tr.setNodeAttribute(tr.doc.content.size - 1, "src", `attachment:${A}`);
  tr.setNodeAttribute(tr.doc.content.size - 1, "width", 100);
  tr.delete(start.content.size, tr.doc.content.size);
  assert.deepEqual(
    tr.steps.map((step) => stepAttachmentIds(step)),
    [[A], [B], [A], [], []],
  );
});

// Review round 2 (docs/reviews/notes-files-backend-round2-astra-review.md).

test("R2-4: only server-rebuilt history may reinsert a legacy image source", () => {
  const start = stored(doc(node.paragraph!.create({ id: "p1" })));
  const legacyImage = notesSchema.nodeFromJSON({
    type: "image",
    attrs: { id: "i9", src: " Attachment:Old/ID ", width: null },
  });
  const step = new ReplaceStep(
    start.content.size,
    start.content.size,
    new Slice(Fragment.from(legacyImage), 0, 0),
  );
  assert.throws(() => applySafeStep(start, step), UnsafeDocumentError);
  const restored = applySafeStep(start, step, { legacySources: true });
  assert.equal(restored.lastChild!.attrs.src, " Attachment:Old/ID ");
  assert.deepEqual(attachmentIds(restored), []);
  // Still no unsafe sources of any other kind.
  const script = notesSchema.nodeFromJSON({
    type: "image",
    attrs: { id: "i8", src: "javascript:alert(1)" },
  });
  assert.throws(
    () =>
      applySafeStep(
        start,
        new ReplaceStep(
          start.content.size,
          start.content.size,
          new Slice(Fragment.from(script), 0, 0),
        ),
        { legacySources: true },
      ),
    UnsafeDocumentError,
  );
});

// Review round 3 (docs/reviews/notes-files-backend-round3-astra-review.md).

test("R3-3: usesFileFeatures and stepUsesFileFeatures find what the gate holds back", async () => {
  const { usesFileFeatures, stepUsesFileFeatures } =
    await import("../src/index.ts");
  const web = node.image!.create({
    id: "i1",
    src: "https://example.com/a.png",
  });
  assert.equal(usesFileFeatures(doc(web)), false);
  assert.equal(usesFileFeatures(doc(node.paragraph!.create())), false);
  assert.equal(
    usesFileFeatures(
      doc(node.image!.create({ src: "https://example.com/a.png", width: 300 })),
    ),
    true,
  );
  assert.equal(
    usesFileFeatures(doc(node.image!.create({ src: `attachment:${A}` }))),
    true,
  );
  assert.equal(usesFileFeatures(doc(file({}))), true);
  assert.equal(
    usesFileFeatures(markdownToDoc(`> - [a](attachment:${A})`)),
    true,
  );
  const start = stored(doc(web));
  const steps = new Transform(start)
    .setNodeAttribute(0, "width", 300)
    .setNodeAttribute(0, "width", null)
    .setNodeAttribute(0, "src", `attachment:${A}`)
    .setNodeAttribute(0, "alt", "x").steps;
  assert.deepEqual(
    steps.map((step) => stepUsesFileFeatures(step)),
    [true, false, true, false],
  );
  const insertWeb = new Transform(start).insert(
    start.content.size,
    node.image!.create({ src: "https://example.com/b.png" }),
  ).steps[0]!;
  assert.equal(stepUsesFileFeatures(insertWeb), false);
});

test("R3-3: a pasted web image keeps no width; Palladian's own images do", () => {
  const getAttrs = notesSchema.nodes.image!.spec.parseDOM![0]!.getAttrs!;
  const element = (attrs: Record<string, string>) =>
    ({
      getAttribute: (name: string) => attrs[name] ?? null,
    }) as unknown as HTMLElement;
  assert.deepEqual(
    getAttrs(element({ src: "https://example.com/a.png", width: "300" })),
    {
      id: null,
      src: "https://example.com/a.png",
      alt: null,
      title: null,
      width: null,
    },
  );
  assert.equal(
    (
      getAttrs(element({ src: `attachment:${A}`, width: "300" })) as {
        width: number;
      }
    ).width,
    300,
  );
});

// Review round 4 (docs/reviews/notes-files-backend-round4-astra-review.md).

test("R4-2: only file features a note does not already have count as new", async () => {
  const { fileFeatures, addsFileFeatures, stepAddsFileFeatures } =
    await import("../src/index.ts");
  const current = stored(
    doc(
      node.paragraph!.create({ id: "p1" }, notesSchema.text("Text")),
      node.image!.create({ id: "i1", src: `attachment:${A}`, width: 320 }),
      file({ id: "f1", objectId: B }),
    ),
  );
  const existing = fileFeatures(current);
  // The same content again (a replace_all keeping them) is not new.
  assert.equal(addsFileFeatures(current, existing), false);
  const edited = markdownToDoc(docToMarkdown(current).replace("Text", "New"));
  assert.equal(addsFileFeatures(edited, existing), false);
  // Another width, another object: new.
  assert.equal(
    addsFileFeatures(
      doc(node.image!.create({ src: `attachment:${A}`, width: 400 })),
      existing,
    ),
    true,
  );
  assert.equal(
    addsFileFeatures(doc(file({ objectId: "0".repeat(20) })), existing),
    true,
  );
  const imagePos = current.child(0).nodeSize;
  const steps = new Transform(current)
    .setNodeAttribute(imagePos, "width", 320)
    .setNodeAttribute(imagePos, "width", 100).steps;
  assert.equal(stepAddsFileFeatures(steps[0]!, current, existing), false);
  assert.equal(stepAddsFileFeatures(steps[1]!, current, existing), true);
  // A whole-document replacement with the same features is not new.
  const replaceAll = new Transform(current).replaceWith(
    0,
    current.content.size,
    edited.content,
  ).steps[0]!;
  assert.equal(stepAddsFileFeatures(replaceAll, current, existing), false);
});
