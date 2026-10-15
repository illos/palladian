import assert from "node:assert/strict";
import { test } from "node:test";
import { Step, Transform } from "prosemirror-transform";
import {
  applyEdits,
  assignBlockIds,
  blockHash,
  blockIdProblems,
  deriveSummary,
  docToMarkdown,
  EditError,
  emptyDoc,
  markdownToDoc,
  notesSchema,
  outline,
  parseStoredDoc,
  plainText,
} from "../src/index.ts";

const sample = [
  "# Groceries",
  "",
  "Buy **milk**, *eggs* and ~~bread~~ from [the shop](https://example.com).",
  "",
  "- apples",
  "- pears",
  "",
  "1. first",
  "2. second",
  "",
  "- [ ] call mum",
  "- [x] pay rent",
  "",
  "> quoted",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "---",
  "",
  "![a cat](https://example.com/cat.png)",
  "",
  "Inline `code` here.",
].join("\n");

function ids(doc: ReturnType<typeof markdownToDoc>) {
  const result: string[] = [];
  doc.descendants((node) => {
    if (node.attrs.id) result.push(String(node.attrs.id));
  });
  return result;
}

test("parses every supported format", () => {
  const doc = markdownToDoc(sample);
  const types: string[] = [];
  doc.forEach((node) => types.push(node.type.name));
  assert.deepEqual(types, [
    "heading",
    "paragraph",
    "bullet_list",
    "ordered_list",
    "task_list",
    "blockquote",
    "code_block",
    "horizontal_rule",
    "image",
    "paragraph",
  ]);
  const task = doc.child(4);
  assert.equal(task.child(0).attrs.checked, false);
  assert.equal(task.child(1).attrs.checked, true);
  assert.equal(task.child(0).textContent, "call mum");
  assert.equal(doc.child(6).attrs.language, "ts");
  const marks = new Set<string>();
  doc.child(1).forEach((n) => n.marks.forEach((m) => marks.add(m.type.name)));
  assert.deepEqual([...marks].sort(), ["em", "link", "strike", "strong"]);
});

test("round-trips canonical Markdown", () => {
  const doc = markdownToDoc(sample);
  const md = docToMarkdown(doc);
  const again = markdownToDoc(md);
  assert.equal(docToMarkdown(again), md);
  assert.match(md, /- \[ \] call mum\n- \[x\] pay rent/);
  assert.match(md, /~~bread~~/);
});

test("assigns unique IDs to every block", () => {
  const doc = markdownToDoc(sample);
  const all = ids(doc);
  assert.ok(all.length >= 14);
  assert.equal(new Set(all).size, all.length);
  assert.equal(blockIdProblems(doc), 0);
});

test("repairs duplicate and missing IDs", () => {
  const doc = notesSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "same" },
        content: [{ type: "text", text: "a" }],
      },
      {
        type: "paragraph",
        attrs: { id: "same" },
        content: [{ type: "text", text: "b" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "c" }] },
    ],
  });
  assert.equal(blockIdProblems(doc), 2);
  const fixed = assignBlockIds(new Transform(doc)).doc;
  assert.equal(blockIdProblems(fixed), 0);
  assert.equal(fixed.child(0).attrs.id, "same");
});

test("drops unsafe links and image sources and keeps HTML as text", () => {
  const doc = markdownToDoc(
    "[x](javascript:alert(1)) [y](ftp://host/f) <b>bold</b>\n\n![p](http://insecure/p.png) ![d](data:image/png;base64,AAA)",
  );
  const hrefs: string[] = [];
  doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === "link") hrefs.push(String(mark.attrs.href));
    assert.notEqual(node.type.name, "image");
  });
  assert.deepEqual(hrefs, []);
  assert.match(plainText(doc), /<b>bold<\/b>/);
});

test("clamps heading levels to three", () => {
  const doc = markdownToDoc("###### deep");
  assert.equal(doc.child(0).attrs.level, 3);
});

test("derives first-line titles", () => {
  assert.deepEqual(deriveSummary(markdownToDoc(sample)).title, "Groceries");
  const untitled = markdownToDoc("\n\nsecond line");
  assert.equal(deriveSummary(untitled).title, "second line");
  const doc = notesSchema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", attrs: { id: "a" } },
      {
        type: "paragraph",
        attrs: { id: "b" },
        content: [{ type: "text", text: "body" }],
      },
    ],
  });
  assert.deepEqual(deriveSummary(doc), { title: "", preview: "body" });
});

test("replace_text keeps the edited block's ID", () => {
  const doc = markdownToDoc("Title\n\nThe quick brown fox.\n\nEnd");
  const id = doc.child(1).attrs.id;
  const tr = applyEdits(doc, [
    { type: "replace_text", old_text: "quick brown", new_text: "slow red" },
  ]);
  assert.equal(tr.doc.child(1).textContent, "The slow red fox.");
  assert.equal(tr.doc.child(1).attrs.id, id);
  assert.equal(tr.doc.child(0).attrs.id, doc.child(0).attrs.id);
});

test("replace_text rejects missing and ambiguous matches", () => {
  const doc = markdownToDoc("a cat\n\na cat");
  assert.throws(
    () =>
      applyEdits(doc, [
        { type: "replace_text", old_text: "dog", new_text: "x" },
      ]),
    (e: unknown) => e instanceof EditError && e.code === "not_found",
  );
  assert.throws(
    () =>
      applyEdits(doc, [
        { type: "replace_text", old_text: "a cat", new_text: "x" },
      ]),
    (e: unknown) => e instanceof EditError && e.code === "ambiguous",
  );
});

test("replace_text can span blocks and use Markdown syntax", () => {
  const doc = markdownToDoc("One\n\nTwo **bold**\n\nThree");
  const tr = applyEdits(doc, [
    {
      type: "replace_text",
      old_text: "One\n\nTwo **bold**",
      new_text: "Merged",
    },
  ]);
  assert.equal(docToMarkdown(tr.doc), "Merged\n\nThree");
});

test("append replaces an empty new note", () => {
  const tr = applyEdits(emptyDoc(), [
    { type: "append", markdown: "# Hi\n\nthere" },
  ]);
  assert.equal(docToMarkdown(tr.doc), "# Hi\n\nthere");
  assert.equal(blockIdProblems(tr.doc), 0);
});

test("block operations target list items", () => {
  const doc = markdownToDoc("Todo\n\n- [ ] one\n- [ ] two");
  const items = outline(doc).filter((e) => e.type === "task_item");
  assert.equal(items.length, 2);
  const tr = applyEdits(doc, [
    { type: "set_checked", block_id: items[0]!.id, checked: true },
    { type: "insert_after", block_id: items[1]!.id, markdown: "- [ ] three" },
    { type: "replace_block", block_id: items[1]!.id, markdown: "deux" },
  ]);
  assert.equal(
    docToMarkdown(tr.doc),
    "Todo\n\n- [x] one\n- [ ] deux\n- [ ] three",
  );
  assert.equal(tr.doc.child(1).child(1).attrs.id, items[1]!.id);
});

test("block hash conflicts reject the whole batch", () => {
  const doc = markdownToDoc("A\n\nB");
  const target = outline(doc)[1]!;
  assert.equal(target.hash, blockHash(doc.child(1)));
  assert.throws(
    () =>
      applyEdits(doc, [
        { type: "append", markdown: "C" },
        { type: "delete_block", block_id: target.id, block_hash: "00000000" },
      ]),
    (e: unknown) =>
      e instanceof EditError && e.code === "conflict" && e.editIndex === 1,
  );
});

test("deleting the only block leaves an empty paragraph", () => {
  const doc = markdownToDoc("Only");
  const tr = applyEdits(doc, [
    { type: "delete_block", block_id: String(doc.child(0).attrs.id) },
  ]);
  assert.equal(tr.doc.childCount, 1);
  assert.equal(tr.doc.child(0).type.name, "paragraph");
  assert.equal(tr.doc.child(0).content.size, 0);
});

test("replace_all reuses positional IDs", () => {
  const doc = markdownToDoc("Title\n\nBody");
  const tr = applyEdits(doc, [
    { type: "replace_all", markdown: "Title 2\n\nBody 2\n\nNew" },
  ]);
  assert.equal(tr.doc.child(0).attrs.id, doc.child(0).attrs.id);
  assert.equal(tr.doc.child(1).attrs.id, doc.child(1).attrs.id);
  assert.equal(blockIdProblems(tr.doc), 0);
});

test("edit steps replay onto the original document", () => {
  const doc = markdownToDoc(sample);
  const tr = applyEdits(doc, [
    { type: "replace_text", old_text: "call mum", new_text: "call dad" },
    { type: "append", markdown: "Done." },
  ]);
  let replay = doc;
  for (const step of tr.steps) {
    const restored = Step.fromJSON(
      notesSchema,
      JSON.parse(JSON.stringify(step.toJSON())),
    );
    const result = restored.apply(replay);
    assert.ok(result.doc, result.failed ?? "step failed");
    replay = result.doc;
  }
  assert.ok(replay.eq(tr.doc));
});

test("stored documents are validated", () => {
  const doc = markdownToDoc(sample);
  assert.ok(parseStoredDoc(JSON.stringify(doc.toJSON())).eq(doc));
  assert.throws(() => parseStoredDoc(JSON.stringify({ type: "paragraph" })));
  assert.throws(() =>
    parseStoredDoc(
      JSON.stringify({ type: "doc", content: [{ type: "bogus" }] }),
    ),
  );
});

test("stored and submitted documents reject unsafe attributes", async () => {
  const { UnsafeDocumentError } = await import("../src/index.ts");
  const link = notesSchema.marks.link!.create({ href: "javascript:alert(1)" });
  const unsafeLink = notesSchema.topNodeType.create(
    null,
    notesSchema.nodes.paragraph!.create(
      { id: "p" },
      notesSchema.text("x", [link]),
    ),
  );
  assert.throws(
    () => parseStoredDoc(JSON.stringify(unsafeLink.toJSON())),
    UnsafeDocumentError,
  );
  const httpImage = notesSchema.topNodeType.create(null, [
    notesSchema.nodes.image!.create({
      id: "i",
      src: "http://example.test/a.png",
    }),
  ]);
  assert.throws(
    () => parseStoredDoc(JSON.stringify(httpImage.toJSON())),
    UnsafeDocumentError,
  );
  const badLevel = notesSchema.topNodeType.create(null, [
    notesSchema.nodes.heading!.create(
      { id: "h", level: 9 },
      notesSchema.text("x"),
    ),
  ]);
  assert.throws(
    () => parseStoredDoc(JSON.stringify(badLevel.toJSON())),
    UnsafeDocumentError,
  );
  const odd = markdownToDoc("```{.python}\ncode\n```");
  assert.equal(odd.child(0).attrs.language, ".python");
});

test("replacing a block separator merges the neighbouring blocks", () => {
  const tr = applyEdits(markdownToDoc("one\n\ntwo"), [
    { type: "replace_text", old_text: "\n\n", new_text: " " },
  ]);
  assert.equal(docToMarkdown(tr.doc), "one two");
  const split = applyEdits(markdownToDoc("one two"), [
    { type: "replace_text", old_text: " ", new_text: "\n\n" },
  ]);
  assert.equal(docToMarkdown(split.doc), "one\n\ntwo");
});

test("diffStep turns one version into another", async () => {
  const { diffStep } = await import("../src/index.ts");
  const a = markdownToDoc("Title\n\nFirst paragraph\n\n- item");
  const b = applyEdits(a, [
    { type: "replace_text", old_text: "First", new_text: "Changed" },
    { type: "append", markdown: "More" },
  ]).doc;
  const step = diffStep(a, b)!;
  assert.ok(step.apply(a).doc!.eq(b));
  assert.equal(diffStep(a, a), null);
});

test("diffSteps keeps unchanged text between edits when rebased", async () => {
  const { diffSteps } = await import("../src/index.ts");
  const { EditorState } = await import("prosemirror-state");
  const { collab, receiveTransaction, sendableSteps } =
    await import("prosemirror-collab");
  const base = markdownToDoc("Alpha middle Omega");
  const start = EditorState.create({ doc: base });
  const local = start.tr
    .insertText("ALPHA", 1, 6)
    .insertText("OMEGA", 14, 19).doc;
  const remote = start.tr.insertText("COLLABORATOR", 7, 13);
  const steps = diffSteps(base, local)!;
  assert.ok(steps.length > 1);
  let state = EditorState.create({
    doc: base,
    plugins: [collab({ version: 0, clientID: "me" })],
  });
  const tr = state.tr;
  for (const step of steps) tr.step(step);
  state = state.apply(tr);
  assert.ok(state.doc.eq(local));
  state = state.apply(receiveTransaction(state, remote.steps, ["them"]));
  assert.equal(state.doc.textContent, "ALPHA COLLABORATOR OMEGA");
  assert.ok(sendableSteps(state));
});

test("diffSteps reproduces structural and attribute changes exactly", async () => {
  const { diffSteps } = await import("../src/index.ts");
  const cases: [string, string][] = [
    ["one\n\ntwo\n\nthree", "one\n\nthree"],
    ["one\n\nthree", "one\n\ntwo\n\nthree"],
    ["# Title\n\nbody", "## Title\n\nbody"],
    ["- [ ] task\n- [ ] other", "- [x] task\n- [ ] other"],
    ["plain words", "plain **bold** words"],
    ["- a\n- b", "1. a\n2. b"],
    ["", "Everything new\n\n> quoted"],
    [sample, "Short"],
  ];
  for (const [before, after] of cases) {
    const a = markdownToDoc(before);
    const b = markdownToDoc(after);
    const tr = new Transform(a);
    for (const step of diffSteps(a, b)!) tr.step(step);
    assert.equal(
      docToMarkdown(tr.doc),
      docToMarkdown(b),
      `${before} → ${after}`,
    );
  }
  assert.deepEqual(diffSteps(markdownToDoc("same"), markdownToDoc("same")), []);
});

test("steps inserting malformed nested content are rejected", async () => {
  const { applySafeStep, UnsafeDocumentError } =
    await import("../src/index.ts");
  const { Fragment, Slice } = await import("prosemirror-model");
  const { ReplaceStep } = await import("prosemirror-transform");
  const valid = markdownToDoc("fine");
  const invalid = notesSchema.nodes.blockquote!.create(
    { id: "q" },
    notesSchema.text("bad"),
  );
  const step = new ReplaceStep(
    0,
    valid.content.size,
    new Slice(Fragment.from(invalid), 0, 0),
  );
  assert.throws(() => applySafeStep(valid, step), UnsafeDocumentError);
});

/** Local steps from diffSteps, rebased over a collaborator's transaction. */
async function rebased(
  base: ReturnType<typeof markdownToDoc>,
  local: ReturnType<typeof markdownToDoc>,
  remote: Transform,
) {
  const { contentKey, diffSteps } = await import("../src/index.ts");
  const { EditorState } = await import("prosemirror-state");
  const { collab, receiveTransaction } = await import("prosemirror-collab");
  const steps = diffSteps(base, local);
  assert.ok(steps, "a fine-grained diff exists");
  let state = EditorState.create({
    doc: base,
    plugins: [collab({ version: 0, clientID: "me" })],
  });
  const tr = state.tr;
  for (const step of steps) tr.step(step);
  state = state.apply(tr);
  assert.equal(
    contentKey(state.doc),
    contentKey(local),
    "the steps reproduce the local document",
  );
  return state.apply(receiveTransaction(state, remote.steps, ["them"])).doc;
}

function textPos(doc: ReturnType<typeof markdownToDoc>, text: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text))
      found = pos + node.text!.indexOf(text);
  });
  assert.ok(found >= 0, text);
  return found;
}

test("diffSteps counts positions in UTF-16 units around emoji", async () => {
  const base = markdownToDoc("😀 Alpha middle Omega 👍🏽");
  const alpha = textPos(base, "Alpha");
  const omega = textPos(base, "Omega");
  const local = new Transform(base)
    .replaceWith(omega, omega + 5, notesSchema.text("OMEGA"))
    .replaceWith(alpha, alpha + 5, notesSchema.text("ALPHA")).doc;
  const middle = textPos(base, "middle");
  const remote = new Transform(base).replaceWith(
    middle,
    middle + 6,
    notesSchema.text("COLLABORATOR"),
  );
  const merged = await rebased(base, local, remote);
  assert.equal(merged.textContent, "😀 ALPHA COLLABORATOR OMEGA 👍🏽");
});

test("diffSteps stays fine-grained in long paragraphs", async () => {
  const base = markdownToDoc("Alpha " + "x".repeat(2100) + " Omega");
  const end = base.content.size - 1;
  const local = new Transform(base)
    .replaceWith(end - 5, end, notesSchema.text("OMEGA"))
    .replaceWith(1, 6, notesSchema.text("ALPHA")).doc;
  const remote = new Transform(base).replaceWith(
    1000,
    1001,
    notesSchema.text("Y"),
  );
  const merged = await rebased(base, local, remote);
  assert.match(merged.textContent, /^ALPHA x+Yx+ OMEGA$/);
  assert.equal(merged.textContent.length, base.textContent.length);
});

test("diffSteps keeps others' text through type changes and new blocks", async () => {
  const base = markdownToDoc("First line here\n\nSecond line");
  // Local: the first paragraph becomes a heading and gains a word; a new
  // paragraph is inserted after it.
  const local = markdownToDoc(
    "## First line here now\n\nInserted\n\nSecond line",
  );
  const line = textPos(base, "line");
  const remote = new Transform(base).replaceWith(
    line,
    line + 4,
    notesSchema.text("LINE"),
  );
  const merged = await rebased(base, local, remote);
  assert.equal(
    docToMarkdown(merged),
    "## First LINE here now\n\nInserted\n\nSecond line",
  );
});

test("diffSteps refuses documents too different to align", async () => {
  const { diffSteps } = await import("../src/index.ts");
  assert.equal(
    diffSteps(markdownToDoc("a".repeat(3000)), markdownToDoc("b".repeat(3000))),
    null,
  );
});

test("diffSteps reproduces random edits exactly", async () => {
  const { contentKey, diffSteps } = await import("../src/index.ts");
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words = ["ab", "b", "😀", "cab", "a", "**ba**", "`c`", "é"];
  const line = () =>
    Array.from({ length: 1 + random(6) }, () => words[random(words.length)])
      .join(" ")
      .trim();
  const block = () =>
    [line(), "# " + line(), "- " + line(), "> " + line(), "- [ ] " + line()][
      random(5)
    ]!;
  for (let round = 0; round < 300; round++) {
    const blocks = Array.from({ length: 1 + random(5) }, block);
    const edited = blocks.map((b) => (random(3) ? b : block()));
    if (random(2)) edited.splice(random(edited.length + 1), 0, block());
    if (random(3) === 0 && edited.length > 1)
      edited.splice(random(edited.length), 1);
    const base = markdownToDoc(blocks.join("\n\n"));
    const local = markdownToDoc(edited.join("\n\n"));
    const steps = diffSteps(base, local);
    assert.ok(steps, `round ${round}`);
    const tr = new Transform(base);
    for (const step of steps) tr.step(step);
    assert.equal(contentKey(tr.doc), contentKey(local), `round ${round}`);
  }
});
