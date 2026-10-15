import {
  applySafeStep,
  markdownToDoc,
  notesSchema,
} from "@palladian/notes-core";
import {
  baseKeymap,
  joinBackward,
  lift,
  setBlockType,
  splitBlock,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
  wrapInList,
} from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { describe, expect, test } from "vitest";

const { nodes, marks } = notesSchema;

/** Position just after the first occurrence of `text`'s first `offset` characters. */
function at(doc: ProseMirrorNode, text: string, offset = 0) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    const index = node.isText ? node.text!.indexOf(text) : -1;
    if (index >= 0) found = pos + index + offset;
    return true;
  });
  if (found < 0) throw new Error("text not found: " + text);
  return found;
}

/**
 * Run an editor command, then replay its steps through the server's
 * validation: every ordinary editing command must be accepted step by step.
 */
function run(
  doc: ProseMirrorNode,
  command: Command,
  from: number,
  to = from,
): ProseMirrorNode {
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  });
  let result: ProseMirrorNode | null = null;
  let steps: Parameters<typeof applySafeStep>[1][] = [];
  const ran = command(state, (tr) => {
    result = tr.doc;
    steps = tr.steps;
  });
  expect(ran).toBe(true);
  let replay = doc;
  for (const step of steps) replay = applySafeStep(replay, step);
  expect(replay.eq(result!)).toBe(true);
  return replay;
}

describe("editor commands pass step validation", () => {
  test("quote, lift and block types", () => {
    const doc = markdownToDoc("Hello world\n\nSecond");
    const quoted = run(doc, wrapIn(nodes.blockquote!), at(doc, "world"));
    expect(quoted.child(0).type).toBe(nodes.blockquote);
    run(quoted, lift, at(quoted, "world"));
    run(doc, setBlockType(nodes.heading!, { level: 2 }), at(doc, "Hello"));
    run(doc, setBlockType(nodes.code_block!), at(doc, "Second"));
    const both = run(
      doc,
      wrapIn(nodes.blockquote!),
      at(doc, "Hello"),
      at(doc, "Second", 3),
    );
    expect(both.childCount).toBe(1);
  });

  test("lists: wrap, split, sink, lift and toggle off", () => {
    const doc = markdownToDoc("one\n\ntwo");
    for (const type of ["bullet_list", "ordered_list", "task_list"]) {
      const listed = run(doc, wrapInList(nodes[type]!), at(doc, "one"));
      expect(listed.child(0).type.name).toBe(type);
    }
    const list = markdownToDoc("- one\n- two");
    const split = run(
      list,
      splitListItem(nodes.list_item!),
      at(list, "one", 3),
    );
    expect(split.child(0).childCount).toBe(3);
    const sunk = run(list, sinkListItem(nodes.list_item!), at(list, "two"));
    run(sunk, liftListItem(nodes.list_item!), at(sunk, "two"));
    run(list, liftListItem(nodes.list_item!), at(list, "one"));
    const tasks = markdownToDoc("- [ ] call\n- [x] pay");
    run(tasks, splitListItem(nodes.task_item!), at(tasks, "call", 4));
    run(tasks, sinkListItem(nodes.task_item!), at(tasks, "pay"));
  });

  test("marks, splitting and joining", () => {
    const doc = markdownToDoc("Hello world\n\nSecond");
    for (const mark of ["strong", "em", "strike", "code"])
      run(doc, toggleMark(marks[mark]!), at(doc, "world"), at(doc, "world", 5));
    const split = run(doc, splitBlock, at(doc, "world"));
    expect(split.childCount).toBe(3);
    run(doc, joinBackward, at(doc, "Second"));
    run(doc, baseKeymap.Backspace!, at(doc, "Hello"), at(doc, "Second", 3));
  });

  test("malformed structure in an inserted slice is still rejected", async () => {
    const { Fragment, Slice } = await import("prosemirror-model");
    const { ReplaceStep } = await import("prosemirror-transform");
    const doc = markdownToDoc("fine");
    const bad = nodes.blockquote!.create({ id: "q" }, notesSchema.text("x"));
    expect(() =>
      applySafeStep(
        doc,
        new ReplaceStep(
          0,
          doc.content.size,
          new Slice(Fragment.from(bad), 0, 0),
        ),
      ),
    ).toThrow(/malformed/);
  });
});
