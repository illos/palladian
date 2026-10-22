import { notesSchema } from "@palladian/notes-core";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, test } from "vitest";
import { enterKey, markdownShortcuts } from "../../src/editor";

const { nodes } = notesSchema;

/** Just enough of a view for input rules: state, dispatch and composition. */
function fakeView(state: EditorState) {
  const view = {
    state,
    composing: false,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}

/** Type each character as the browser would, letting input rules run. */
function type(state: EditorState, text: string) {
  const view = fakeView(state);
  const handle = markdownShortcuts.props.handleTextInput!;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = handle.call(
      markdownShortcuts,
      view as unknown as EditorView,
      from,
      to,
      char,
      () => view.state.tr.insertText(char, from, to),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
  return view.state;
}

function paragraphState(text = "") {
  const doc = nodes.doc!.create(
    null,
    nodes.paragraph!.create(null, text ? notesSchema.text(text) : null),
  );
  return EditorState.create({
    doc,
    plugins: [markdownShortcuts],
    selection: TextSelection.atEnd(doc),
  });
}

describe("Markdown shortcuts", () => {
  test("italic keeps the character before the opening asterisk", () => {
    const state = type(paragraphState(), "a *b*");
    const paragraph = state.doc.firstChild!;
    expect(paragraph.textContent).toBe("a b");
    const italic = paragraph.child(1);
    expect(italic.text).toBe("b");
    expect(italic.marks.map((mark) => mark.type.name)).toEqual(["em"]);
    expect(paragraph.child(0).text).toBe("a ");
  });

  test("italic at the start of a line and bold still work", () => {
    expect(type(paragraphState(), "*b*").doc.firstChild!.textContent).toBe("b");
    const bold = type(paragraphState(), "x **b**").doc.firstChild!;
    expect(bold.textContent).toBe("x b");
    expect(bold.child(1).marks.map((mark) => mark.type.name)).toEqual([
      "strong",
    ]);
  });
});

describe("Enter in a checklist", () => {
  function checkedItem() {
    const doc = nodes.doc!.create(
      null,
      nodes.task_list!.create(null, [
        nodes.task_item!.create(
          { checked: true },
          nodes.paragraph!.create(null, notesSchema.text("Done thing")),
        ),
      ]),
    );
    return EditorState.create({
      doc,
      selection: TextSelection.atEnd(doc),
    });
  }

  test("a new item after a checked one starts unchecked", () => {
    let state = checkedItem();
    expect(enterKey(state, (tr) => (state = state.apply(tr)))).toBe(true);
    const list = state.doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(0).attrs.checked).toBe(true);
    expect(list.child(1).attrs.checked).toBe(false);
  });

  test("Enter on an empty item leaves the list", () => {
    // The editor's keymap falls through to the base Enter, as here.
    const enter = chainCommands(enterKey, baseKeymap.Enter!);
    let state = checkedItem();
    enter(state, (tr) => (state = state.apply(tr)));
    enter(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.firstChild!.childCount).toBe(1);
    expect(state.doc.lastChild!.type.name).toBe("paragraph");
  });
});
