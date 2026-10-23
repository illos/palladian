import {
  applySafeStep,
  assignBlockIds,
  blockIdPlugin,
  blockToMarkdown,
  docToMarkdown,
  markdownToDoc,
  notesSchema,
  parseMarkdownFragment,
} from "@palladian/notes-core";
import { assertSafeFragment } from "@palladian/notes-core/schema";
import {
  Slice,
  type Fragment,
  type Node as ProseMirrorNode,
} from "prosemirror-model";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { collab, receiveTransaction } from "prosemirror-collab";
import { history } from "prosemirror-history";
import { Transform, type Step } from "prosemirror-transform";
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Command,
  type Plugin,
  type Transaction,
} from "prosemirror-state";
import type { DecorationSet, EditorView } from "prosemirror-view";
import { describe, expect, test } from "vitest";
import {
  editorKeys,
  enterWithLinks,
  markdownShortcuts,
  titlePlaceholder,
} from "../../src/editor";
import {
  applyListType,
  endSelection,
  insertDivider,
  insertHardBreak,
  selectEnd,
  setBlock,
  toggleBlock,
} from "../../src/editor-commands";
import {
  applyLink,
  linkable,
  linkDraftFor,
  linkRangeAt,
  linkUi,
  linkUiKey,
  normalizeHref,
  removeLink,
} from "../../src/editor-links";
import {
  clipboardText,
  isPlainSlice,
  loadMarkdown,
  markdownSlice,
  pasteMarkdown,
  safeSlice,
} from "../../src/editor-clipboard";
import { slashKey, slashPalette } from "../../src/editor-slash";

const { nodes, marks } = notesSchema;
const codec = { parseMarkdownFragment, blockToMarkdown };

/** A minimal view: state, dispatch, focus, and the plugins' text and key handlers. */
class Harness {
  state: EditorState;
  composing = false;
  links = 0;
  constructor(
    doc: ProseMirrorNode,
    selection?: (doc: ProseMirrorNode) => TextSelection,
    slash = true,
  ) {
    // The editor's own plugin order, without collaboration and the keymaps.
    const plugins: Plugin[] = [
      blockIdPlugin((tr) => tr.getMeta("rebased") !== undefined),
      history(),
      slashPalette({ enabled: () => slash, openLink: () => this.links++ }),
      linkUi,
      titlePlaceholder,
      markdownShortcuts,
    ];
    this.state = EditorState.create({
      doc,
      plugins,
      selection: selection ? selection(doc) : TextSelection.atEnd(doc),
    });
  }
  get view() {
    return this as unknown as EditorView;
  }
  /** Every step applied, including appended ID repairs, as collab sends them. */
  steps: Step[] = [];
  dispatch = (tr: Transaction) => {
    const { state, transactions } = this.state.applyTransaction(tr);
    for (const applied of transactions) this.steps.push(...applied.steps);
    this.state = state;
  };
  /** Replay the steps through the server's per-step validation. */
  replay(start: ProseMirrorNode) {
    let doc = start;
    for (const step of this.steps) doc = applySafeStep(doc, step);
    expect(doc.eq(this.state.doc)).toBe(true);
  }
  focus() {}
  endOfTextblock(direction: string, state: EditorState) {
    const $cursor = state.selection.$from;
    return direction === "backward" || direction === "left"
      ? $cursor.parentOffset === 0
      : $cursor.parentOffset === $cursor.parent.content.size;
  }
  /** Type each character as the browser would, letting plugins handle it. */
  type(text: string) {
    for (const char of text) {
      const { from, to } = this.state.selection;
      const handled = this.state.plugins.some((plugin) =>
        plugin.props.handleTextInput?.call(
          plugin,
          this.view,
          from,
          to,
          char,
          () => this.state.tr.insertText(char, from, to),
        ),
      );
      if (!handled) this.dispatch(this.state.tr.insertText(char, from, to));
    }
    return this;
  }
  /** A key press through plugin handlers, then the given fallback command. */
  key(key: string, fallback?: Command) {
    const event = { key } as KeyboardEvent;
    const handled = this.state.plugins.some((plugin) =>
      plugin.props.handleKeyDown?.call(plugin, this.view, event),
    );
    if (!handled && fallback) fallback(this.state, this.dispatch, this.view);
    return this;
  }
  run(command: Command) {
    return command(this.state, this.dispatch, this.view);
  }
}

const keys = editorKeys(() => {});
const backspace = chainCommands(keys.Backspace!, baseKeymap.Backspace!);

/** A document of plain paragraphs with block IDs, as notes have. */
function paragraphs(...lines: string[]) {
  const doc = nodes.doc!.create(
    null,
    lines.map((line) =>
      nodes.paragraph!.create(null, line ? notesSchema.text(line) : null),
    ),
  );
  return assignBlockIds(new Transform(doc)).doc;
}
/** Position of `text` (plus `offset`) in the document. */
function at(doc: ProseMirrorNode, text: string, offset = 0) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText) {
      const index = node.text!.indexOf(text);
      if (index >= 0) found = pos + index + offset;
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`No "${text}" in the document`);
  return found;
}
function select(from: string, to: string) {
  return (doc: ProseMirrorNode) =>
    TextSelection.create(doc, at(doc, from), at(doc, to, to.length));
}
function caret(text: string, offset = 0) {
  return (doc: ProseMirrorNode) =>
    TextSelection.create(doc, at(doc, text, offset));
}
function shape(doc: ProseMirrorNode): unknown {
  const walk = (node: ProseMirrorNode): unknown =>
    node.isText
      ? node.text
      : node.childCount
        ? { [node.type.name]: node.content.content.map(walk) }
        : node.type.name;
  return doc.content.content.map(walk);
}

describe("keys", () => {
  test("Shift-Enter inserts a line break, and a newline in code", () => {
    const h = new Harness(paragraphs("abcd"), caret("abcd", 2));
    expect(h.run(insertHardBreak)).toBe(true);
    expect(shape(h.state.doc)).toEqual([
      { paragraph: ["ab", "hard_break", "cd"] },
    ]);
    const code = new Harness(markdownToDoc("```\nabcd\n```"), caret("abcd", 2));
    code.run(keys["Shift-Enter"]!);
    expect(code.state.doc.firstChild!.textContent).toBe("ab\ncd");
  });

  test("Backspace right after a shortcut restores the typed text", () => {
    const heading = new Harness(paragraphs("")).type("## ");
    expect(heading.state.doc.firstChild!.type.name).toBe("heading");
    heading.run(backspace);
    expect(shape(heading.state.doc)).toEqual([{ paragraph: ["## "] }]);

    const bold = new Harness(paragraphs("")).type("x **b**");
    expect(bold.state.doc.firstChild!.child(1).marks[0]!.type.name).toBe(
      "strong",
    );
    bold.run(backspace);
    expect(shape(bold.state.doc)).toEqual([{ paragraph: ["x **b**"] }]);

    const list = new Harness(paragraphs("")).type("- ");
    expect(list.state.doc.firstChild!.type.name).toBe("bullet_list");
    // New blocks get IDs within the shortcut itself, so no ID repair follows.
    expect(list.state.doc.firstChild!.attrs.id).toEqual(expect.any(String));
    list.run(backspace);
    expect(shape(list.state.doc)).toEqual([{ paragraph: ["- "] }]);
  });

  test("Backspace otherwise falls through to ordinary deletion", () => {
    const h = new Harness(paragraphs("## x"));
    expect(h.run(keys.Backspace!)).toBe(false);
    // A later edit closes the window for undoing a shortcut.
    const typed = new Harness(paragraphs("")).type("## a");
    expect(typed.run(keys.Backspace!)).toBe(false);
  });

  test("--- on its own line becomes a divider; Backspace restores it", () => {
    const h = new Harness(paragraphs("Above", "")).type("---");
    expect(shape(h.state.doc)).toEqual([
      { paragraph: ["Above"] },
      "horizontal_rule",
      "paragraph",
    ]);
    expect(h.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(h.state.selection.from).toBe(h.state.doc.content.size - 1);
    h.run(backspace);
    expect(shape(h.state.doc)).toEqual([
      { paragraph: ["Above"] },
      { paragraph: ["---"] },
    ]);
    expect(shape(new Harness(paragraphs("a")).type("---").state.doc)).toEqual([
      { paragraph: ["a---"] },
    ]);
  });

  test("Divider at the end, middle and start of a line, and an empty line", () => {
    const end = new Harness(paragraphs("Hello"));
    end.run(insertDivider);
    expect(shape(end.state.doc)).toEqual([
      { paragraph: ["Hello"] },
      "horizontal_rule",
      "paragraph",
    ]);
    expect(end.state.selection.from).toBe(end.state.doc.content.size - 1);
    end.type("x");
    expect(end.state.doc.lastChild!.textContent).toBe("x");

    const middle = new Harness(paragraphs("Hello"), caret("Hello", 2));
    middle.run(insertDivider);
    expect(shape(middle.state.doc)).toEqual([
      { paragraph: ["He"] },
      "horizontal_rule",
      { paragraph: ["llo"] },
    ]);
    expect(middle.state.selection.from).toBe(at(middle.state.doc, "llo"));

    const start = new Harness(paragraphs("Hello"), caret("Hello"));
    start.run(insertDivider);
    expect(shape(start.state.doc)).toEqual([
      "horizontal_rule",
      { paragraph: ["Hello"] },
    ]);

    const empty = new Harness(paragraphs("Hello", ""));
    empty.run(insertDivider);
    expect(shape(empty.state.doc)).toEqual([
      { paragraph: ["Hello"] },
      "horizontal_rule",
      "paragraph",
    ]);
    expect(
      new Harness(markdownToDoc("```\ncode\n```")).run(insertDivider),
    ).toBe(false);
  });

  test("heading, code block and quote shortcuts; Mod-E and Mod-` for inline code", () => {
    const doc = markdownToDoc("Line");
    const id = doc.firstChild!.attrs.id as string;
    const h = new Harness(doc);
    h.run(keys["Mod-Alt-1"]!);
    expect(h.state.doc.firstChild!.attrs).toMatchObject({ level: 1, id });
    h.run(keys["Mod-Alt-2"]!);
    expect(h.state.doc.firstChild!.attrs.level).toBe(2);
    h.run(keys["Mod-Alt-3"]!);
    expect(h.state.doc.firstChild!.attrs.level).toBe(3);
    h.run(keys["Mod-Alt-3"]!);
    expect(h.state.doc.firstChild!.type.name).toBe("paragraph");
    h.run(keys["Mod-Alt-c"]!);
    expect(h.state.doc.firstChild!.type.name).toBe("code_block");
    h.run(keys["Mod-Alt-0"]!);
    expect(h.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(h.state.doc.firstChild!.attrs.id).toBe(id);
    h.run(keys["Mod-Shift-."]!);
    expect(h.state.doc.firstChild!.type.name).toBe("blockquote");
    h.run(keys["Mod-Shift->"]!);
    expect(h.state.doc.firstChild!.type.name).toBe("paragraph");

    expect(keys["Mod-`"]).toBe(keys["Mod-e"]);
    const code = new Harness(paragraphs("a word"), select("word", "word"));
    code.run(keys["Mod-`"]!);
    expect(code.state.doc.firstChild!.child(1).marks[0]!.type.name).toBe(
      "code",
    );
  });
});

describe("block styles", () => {
  test("an active style tapped again returns the block to body text", () => {
    const h = new Harness(markdownToDoc("Line"));
    const title = toggleBlock(nodes.heading!, { level: 1 });
    h.run(title);
    expect(h.state.doc.firstChild!.type.name).toBe("heading");
    h.run(title);
    expect(h.state.doc.firstChild!.type.name).toBe("paragraph");
    const mono = toggleBlock(nodes.code_block!);
    h.run(mono);
    expect(h.state.doc.firstChild!.type.name).toBe("code_block");
    h.run(mono);
    expect(h.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(h.run(setBlock(nodes.paragraph!))).toBe(false);
  });

  test("styles apply to every block in a selection", () => {
    const h = new Harness(paragraphs("One", "Two"), select("One", "Two"));
    h.run(toggleBlock(nodes.heading!, { level: 2 }));
    expect(shape(h.state.doc)).toEqual([
      { heading: ["One"] },
      { heading: ["Two"] },
    ]);
  });
});

describe("lists", () => {
  test("selected paragraphs convert exclusively between list kinds", () => {
    const h = new Harness(
      paragraphs("One", "Two", "Three"),
      select("One", "Three"),
    );
    h.run(applyListType("bullet"));
    expect(shape(h.state.doc)).toEqual([
      {
        bullet_list: [
          { list_item: [{ paragraph: ["One"] }] },
          { list_item: [{ paragraph: ["Two"] }] },
          { list_item: [{ paragraph: ["Three"] }] },
        ],
      },
    ]);
    h.run(applyListType("checklist"));
    expect(h.state.doc.childCount).toBe(1);
    expect(h.state.doc.firstChild!.type.name).toBe("task_list");
    expect(h.state.doc.firstChild!.childCount).toBe(3);
    h.run(applyListType("ordered"));
    expect(h.state.doc.firstChild!.type.name).toBe("ordered_list");
    expect(h.state.doc.firstChild!.childCount).toBe(3);
    h.run(applyListType("ordered"));
    expect(shape(h.state.doc)).toEqual([
      { paragraph: ["One"] },
      { paragraph: ["Two"] },
      { paragraph: ["Three"] },
    ]);
    expect(h.state.selection.from).toBe(at(h.state.doc, "One"));
    h.state.doc.check();
  });

  test("bullet and numbered switch the whole list; a checklist converts the item", () => {
    const doc = markdownToDoc("- a\n- b\n- c");
    const listId = doc.firstChild!.attrs.id as string;
    const whole = new Harness(doc, caret("b"));
    whole.run(applyListType("ordered"));
    expect(shape(whole.state.doc)).toEqual([
      {
        ordered_list: [
          { list_item: [{ paragraph: ["a"] }] },
          { list_item: [{ paragraph: ["b"] }] },
          { list_item: [{ paragraph: ["c"] }] },
        ],
      },
    ]);
    expect(whole.state.doc.firstChild!.attrs.id).toBe(listId);

    const split = new Harness(markdownToDoc("1. a\n2. b\n3. c"), caret("b"));
    split.run(applyListType("checklist"));
    const lists = split.state.doc.content.content;
    expect(lists.map((node) => node.type.name)).toEqual([
      "ordered_list",
      "task_list",
      "ordered_list",
    ]);
    expect(lists[2]!.attrs.order).toBe(3);
    expect(lists[1]!.firstChild!.attrs.checked).toBe(false);
    expect(split.state.selection.from).toBe(at(split.state.doc, "b"));
    split.run(applyListType("ordered"));
    expect(shape(split.state.doc)).toEqual([
      {
        ordered_list: [
          { list_item: [{ paragraph: ["a"] }] },
          { list_item: [{ paragraph: ["b"] }] },
          { list_item: [{ paragraph: ["c"] }] },
        ],
      },
    ]);
  });

  test("a paragraph next to a list of the same kind joins it", () => {
    const h = new Harness(markdownToDoc("- a\n\nb"), caret("b"));
    h.run(applyListType("bullet"));
    expect(h.state.doc.childCount).toBe(1);
    expect(h.state.doc.firstChild!.childCount).toBe(2);
  });

  test("a selection over a paragraph and a list makes one list", () => {
    const h = new Harness(
      markdownToDoc("a\n\n- [ ] b\n- [x] c"),
      select("a", "c"),
    );
    h.run(applyListType("checklist"));
    expect(h.state.doc.childCount).toBe(1);
    const list = h.state.doc.firstChild!;
    expect(list.type.name).toBe("task_list");
    expect(list.content.content.map((item) => item.attrs.checked)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("lists are unavailable in headings and code", () => {
    expect(
      new Harness(markdownToDoc("# Head")).run(applyListType("bullet")),
    ).toBe(false);
    expect(
      new Harness(markdownToDoc("```\nx\n```")).run(applyListType("checklist")),
    ).toBe(false);
  });

  test("a nested checklist chosen again becomes paragraphs inside its item", () => {
    const h = new Harness(
      markdownToDoc("- outer\n  - [ ] inner"),
      caret("inner"),
    );
    h.run(applyListType("checklist"));
    h.state.doc.check();
    expect(shape(h.state.doc)).toEqual([
      {
        bullet_list: [
          { list_item: [{ paragraph: ["outer"] }, { paragraph: ["inner"] }] },
        ],
      },
    ]);
  });

  test("Enter on an empty bullet item leaves the list", () => {
    const h = new Harness(markdownToDoc("- a"));
    const enter = chainCommands(keys.Enter!, baseKeymap.Enter!);
    h.run(enter);
    h.run(enter);
    expect(shape(h.state.doc)).toEqual([
      { bullet_list: [{ list_item: [{ paragraph: ["a"] }] }] },
      "paragraph",
    ]);
  });
});

describe("links", () => {
  test("addresses are normalized and checked with isSafeHref", () => {
    expect(normalizeHref("example.com")).toBe("https://example.com");
    expect(normalizeHref(" docs.example.com/a?b=1 ")).toBe(
      "https://docs.example.com/a?b=1",
    );
    expect(normalizeHref("https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(normalizeHref("me@example.com")).toBe("mailto:me@example.com");
    expect(normalizeHref("mailto:me@example.com")).toBe(
      "mailto:me@example.com",
    );
    expect(normalizeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeHref("data:text/html,x")).toBeNull();
    expect(normalizeHref("notes")).toBeNull();
    expect(normalizeHref("https://")).toBeNull();
    expect(normalizeHref("")).toBeNull();
  });

  test("Space after a URL or allowlisted domain links it", () => {
    const bare = new Harness(paragraphs("")).type("see example.com ");
    const paragraph = bare.state.doc.firstChild!;
    expect(paragraph.textContent).toBe("see example.com ");
    expect(paragraph.child(1).text).toBe("example.com");
    expect(paragraph.child(1).marks[0]!.attrs.href).toBe("https://example.com");
    expect(paragraph.child(2).marks).toEqual([]);

    const scheme = new Harness(paragraphs("")).type("(https://x.dev/a). ");
    const link = scheme.state.doc.firstChild!.child(1);
    expect(link.text).toBe("https://x.dev/a");
    expect(link.marks[0]!.attrs.href).toBe("https://x.dev/a");

    for (const text of ["file.txt ", "a@google.com ", "etc. ", "3.14 "]) {
      const plain = new Harness(paragraphs("")).type(text);
      expect(
        plain.state.doc.rangeHasMark(
          0,
          plain.state.doc.content.size,
          marks.link!,
        ),
      ).toBe(false);
    }
  });

  test("never inside inline code or a code block", () => {
    const inline = new Harness(paragraphs("")).type("`x.com` ");
    expect(
      inline.state.doc.rangeHasMark(
        0,
        inline.state.doc.content.size,
        marks.link!,
      ),
    ).toBe(false);
    const block = new Harness(markdownToDoc("```\nx\n```")).type(
      " example.com ",
    );
    expect(
      block.state.doc.rangeHasMark(
        0,
        block.state.doc.content.size,
        marks.link!,
      ),
    ).toBe(false);
    const enter = new Harness(markdownToDoc("```\nexample.com\n```"));
    enter.run(enterWithLinks);
    expect(
      enter.state.doc.rangeHasMark(
        0,
        enter.state.doc.content.size,
        marks.link!,
      ),
    ).toBe(false);
  });

  test("Backspace right after autolinking restores the plain text", () => {
    const h = new Harness(paragraphs("")).type("go example.com ");
    h.run(backspace);
    expect(h.state.doc.textContent).toBe("go example.com ");
    expect(
      h.state.doc.rangeHasMark(0, h.state.doc.content.size, marks.link!),
    ).toBe(false);
  });

  test("Enter after a URL links it, then breaks the line", () => {
    const h = new Harness(paragraphs("visit https://example.com/a"));
    h.run(chainCommands(keys.Enter!, baseKeymap.Enter!));
    expect(h.state.doc.childCount).toBe(2);
    const link = h.state.doc.firstChild!.child(1);
    expect(link.text).toBe("https://example.com/a");
    expect(link.marks[0]!.attrs.href).toBe("https://example.com/a");
  });

  test("Backspace at a link's end removes the link and keeps the text", () => {
    const h = new Harness(markdownToDoc("go [site](https://e.com)"));
    h.run(backspace);
    expect(h.state.doc.textContent).toBe("go site");
    expect(
      h.state.doc.rangeHasMark(0, h.state.doc.content.size, marks.link!),
    ).toBe(false);
    // The next Backspace is an ordinary deletion.
    expect(h.run(keys.Backspace!)).toBe(false);
  });

  test("the link form starts from the selection or the link under the caret", () => {
    const selected = new Harness(
      paragraphs("a word here"),
      select("word", "word"),
    );
    expect(linkDraftFor(selected.state)).toMatchObject({
      text: "word",
      href: "",
    });
    const address = new Harness(
      paragraphs("see example.com"),
      select("example.com", "example.com"),
    );
    expect(linkDraftFor(address.state)).toMatchObject({ href: "example.com" });
    const doc = markdownToDoc("go [site](https://e.com) now");
    const inLink = new Harness(doc, caret("site", 2));
    expect(linkDraftFor(inLink.state)).toEqual({
      from: at(doc, "site"),
      to: at(doc, "site", 4),
      text: "site",
      href: "https://e.com",
    });
    expect(
      linkDraftFor(new Harness(markdownToDoc("```\nx\n```")).state),
    ).toBeNull();
    expect(
      linkDraftFor(
        new Harness(paragraphs("One", "Two"), select("One", "Two")).state,
      ),
    ).toBeNull();
  });

  test("applying the form links new text, keeps formatting, and edits links", () => {
    const empty = new Harness(paragraphs("go "));
    const { from } = empty.state.selection;
    empty.dispatch(
      applyLink(empty.state, from, from, "site", "https://e.com")!,
    );
    expect(empty.state.doc.firstChild!.child(1).text).toBe("site");
    expect(empty.state.selection.from).toBe(from + 4);

    const bold = new Harness(markdownToDoc("a **word**"));
    const start = at(bold.state.doc, "word");
    bold.dispatch(
      applyLink(bold.state, start, start + 4, "word", "https://w.dev")!,
    );
    expect(
      bold.state.doc
        .firstChild!.child(1)
        .marks.map((m) => m.type.name)
        .sort(),
    ).toEqual(["link", "strong"]);

    const edit = new Harness(markdownToDoc("[old](https://old.com)"));
    const range = linkRangeAt(edit.state.doc, 2)!;
    edit.dispatch(
      applyLink(edit.state, range.from, range.to, "new", "https://new.com")!,
    );
    expect(docToMarkdown(edit.state.doc)).toBe("[new](https://new.com)");
    const again = linkRangeAt(edit.state.doc, 2)!;
    edit.dispatch(removeLink(edit.state, again.from, again.to));
    expect(docToMarkdown(edit.state.doc)).toBe("new");
  });

  test("the link popover follows remote edits and closes on local typing", () => {
    const doc = markdownToDoc("go [site](https://e.com)");
    const h = new Harness(doc, caret("site", 1));
    const range = linkRangeAt(h.state.doc, at(doc, "site"))!;
    h.dispatch(h.state.tr.setMeta(linkUiKey, { mode: "menu", ...range }));
    h.dispatch(h.state.tr.insertText("Hi ", 1).setMeta("rebased", 0));
    expect(linkUiKey.getState(h.state)).toEqual({
      mode: "menu",
      from: range.from + 3,
      to: range.to + 3,
    });
    h.type("x");
    expect(linkUiKey.getState(h.state)).toBeNull();
  });

  test("the link form's range follows edits until it closes", () => {
    const h = new Harness(paragraphs("a word"), select("word", "word"));
    const { from, to } = h.state.selection;
    h.dispatch(h.state.tr.setMeta(linkUiKey, { mode: "form", from, to }));
    h.dispatch(h.state.tr.insertText("Hi ", 1).setMeta("rebased", 0));
    h.dispatch(h.state.tr.insertText("!", h.state.doc.content.size - 1));
    // Edits outside the range leave it untouched.
    expect(linkUiKey.getState(h.state)).toEqual({
      mode: "form",
      from: from + 3,
      to: to + 3,
      touched: false,
    });
    h.dispatch(h.state.tr.setMeta(linkUiKey, null));
    expect(linkUiKey.getState(h.state)).toBeNull();
  });
});

describe("clipboard", () => {
  test("plain-text Markdown becomes structure; plain prose does not", () => {
    const slice = markdownSlice(
      "# Plan\n\n- one\n- two\n\n1. first\n\n- [ ] task\n\n**bold** end",
      codec,
    )!;
    expect(slice.content.content.map((node) => node.type.name)).toEqual([
      "heading",
      "bullet_list",
      "ordered_list",
      "task_list",
      "paragraph",
    ]);
    expect(slice.openStart).toBe(0);
    expect(slice.openEnd).toBe(1);
    expect(markdownSlice("just words\nand more words", codec)).toBeNull();
    expect(markdownSlice("   ", codec)).toBeNull();
    const inline = markdownSlice("some **bold** text", codec)!;
    expect(inline.openStart).toBe(1);
    expect(inline.content.firstChild!.child(1).marks[0]!.type.name).toBe(
      "strong",
    );
  });

  test("lines of a pasted paragraph stay separate lines", () => {
    const slice = markdownSlice(
      "line one\nline **two**\n- item\n  more\n# Head\n```\na\nb\n```",
      codec,
    )!;
    expect(shape(nodes.doc!.create(null, slice.content))).toEqual([
      { paragraph: ["line one"] },
      { paragraph: ["line ", "two"] },
      {
        bullet_list: [
          { list_item: [{ paragraph: ["item"] }, { paragraph: ["more"] }] },
        ],
      },
      { heading: ["Head"] },
      { code_block: ["a\nb"] },
    ]);
  });

  test("Markdown paste replaces the selection; rich HTML and code keep the default", async () => {
    await loadMarkdown();
    const paste = (h: Harness, text: string, html = "", slice = Slice.empty) =>
      pasteMarkdown(
        h.view,
        {
          clipboardData: {
            getData: (type: string) =>
              type === "text/plain" ? text : type === "text/html" ? html : "",
          },
        } as unknown as ClipboardEvent,
        slice,
      );
    const h = new Harness(paragraphs(""));
    expect(paste(h, "## Steps\n\n1. one\n2. two")).toBe(true);
    expect(shape(h.state.doc)).toEqual([
      { heading: ["Steps"] },
      {
        ordered_list: [
          { list_item: [{ paragraph: ["one"] }] },
          { list_item: [{ paragraph: ["two"] }] },
        ],
      },
    ]);
    expect(paste(new Harness(paragraphs("")), "no markdown here")).toBe(false);
    const rich = new Slice(markdownToDoc("**x**").content, 0, 0);
    expect(paste(new Harness(paragraphs("")), "# x", "<b>x</b>", rich)).toBe(
      false,
    );
    const plainHtml = new Slice(paragraphs("# x").content, 0, 0);
    expect(isPlainSlice(plainHtml)).toBe(true);
    expect(
      paste(new Harness(paragraphs("")), "# x", "<div># x</div>", plainHtml),
    ).toBe(true);
    expect(paste(new Harness(markdownToDoc("```\nx\n```")), "# x")).toBe(false);
  });

  test("copy puts Markdown on the plain-text clipboard", () => {
    const doc = markdownToDoc(
      "# Title\n\n- one **bold**\n- two\n\n```js\nlet a = 1;\n```",
    );
    const all = new AllSelection(doc).content();
    expect(clipboardText(all, codec)).toBe(docToMarkdown(doc));
    const word = doc.slice(at(doc, "one"), at(doc, "one", 3), true);
    expect(clipboardText(word, codec)).toBe("one");
    const formatted = doc.slice(at(doc, "one"), at(doc, "bold", 4), true);
    expect(clipboardText(formatted, codec)).toBe("one **bold**");
    const items = doc.slice(at(doc, "one"), at(doc, "two", 3), true);
    expect(clipboardText(items, codec)).toBe("- one **bold**\n- two");
    const code = doc.slice(at(doc, "let"), at(doc, "1;", 2), true);
    expect(clipboardText(code, codec)).toBe("let a = 1;");
    const heading = doc.slice(at(doc, "Title", 1), at(doc, "Title", 5), true);
    expect(clipboardText(heading, codec)).toBe("itle");
    expect(clipboardText(all, null)).toBe(
      all.content.textBetween(0, all.content.size, "\n\n"),
    );
  });
});

describe("focus", () => {
  test("an empty first line shows the Title placeholder without text", () => {
    const decorations = (doc: ProseMirrorNode) =>
      titlePlaceholder.props.decorations!.call(
        titlePlaceholder,
        EditorState.create({ doc }),
      ) as DecorationSet | null;
    const empty = paragraphs("");
    const found = decorations(empty)!.find();
    expect(found).toHaveLength(1);
    expect(found[0]!.from).toBe(0);
    expect(empty.textContent).toBe("");
    expect(decorations(paragraphs("", "Body"))!.find()).toHaveLength(1);
    expect(decorations(paragraphs("Title"))).toBeNull();
  });

  test("the caret goes to the end of the text", () => {
    const doc = markdownToDoc("Title\n\n- a\n- last");
    expect(endSelection(doc)!.from).toBe(at(doc, "last", 4));
    const ruled = new Harness(markdownToDoc("Title\n\n---"));
    ruled.run(selectEnd);
    expect(shape(ruled.state.doc)).toEqual([
      { paragraph: ["Title"] },
      "horizontal_rule",
      "paragraph",
    ]);
    expect(ruled.state.selection.from).toBe(ruled.state.doc.content.size - 1);
  });
});

describe("slash palette", () => {
  test("/ on an empty line opens it; the query filters; Enter applies", () => {
    const h = new Harness(paragraphs("Text", "")).type("/");
    expect(slashKey.getState(h.state)).toMatchObject({ query: "" });
    h.type("h2");
    expect(slashKey.getState(h.state)).toMatchObject({ query: "h2" });
    h.key("Enter");
    expect(slashKey.getState(h.state)).toBeNull();
    expect(shape(h.state.doc)).toEqual([{ paragraph: ["Text"] }, "heading"]);
    expect(h.state.doc.lastChild!.attrs.level).toBe(2);
  });

  test("arrow keys move the highlight; link opens the form", () => {
    const h = new Harness(paragraphs("")).type("/li");
    // "li" matches Bullet list, Numbered list, Checklist, Divider ("line"), Link.
    h.key("ArrowUp");
    expect(slashKey.getState(h.state)!.index).toBe(4);
    h.key("Enter");
    expect(h.links).toBe(1);
    expect(h.state.doc.textContent).toBe("");
  });

  test("only on an empty line or after a space, outside code, when enabled", () => {
    expect(
      slashKey.getState(new Harness(paragraphs("a")).type("/").state),
    ).toBeNull();
    expect(
      slashKey.getState(new Harness(paragraphs("a ")).type("/").state),
    ).not.toBeNull();
    expect(
      slashKey.getState(
        new Harness(markdownToDoc("```\n\n```")).type("/").state,
      ),
    ).toBeNull();
    expect(
      slashKey.getState(
        new Harness(paragraphs(""), undefined, false).type("/").state,
      ),
    ).toBeNull();
  });

  test("Escape and a space close it and keep the typed text", () => {
    const escaped = new Harness(paragraphs("")).type("/co").key("Escape");
    expect(slashKey.getState(escaped.state)).toBeNull();
    expect(escaped.state.doc.textContent).toBe("/co");
    const spaced = new Harness(paragraphs("")).type("/a ");
    expect(slashKey.getState(spaced.state)).toBeNull();
    // With no matching entry, Enter is left to the editor.
    const none = new Harness(paragraphs("")).type("/zzz");
    let entered = false;
    none.key("Enter", () => (entered = true));
    expect(entered).toBe(true);
  });

  test("Divider, Checklist and Quote entries", () => {
    const divider = new Harness(paragraphs("Text", ""))
      .type("/divider")
      .key("Enter");
    expect(shape(divider.state.doc)).toEqual([
      { paragraph: ["Text"] },
      "horizontal_rule",
      "paragraph",
    ]);
    const checklist = new Harness(paragraphs("")).type("/todo").key("Enter");
    expect(checklist.state.doc.firstChild!.type.name).toBe("task_list");
    const quote = new Harness(paragraphs("")).type("/quote").key("Enter");
    expect(quote.state.doc.firstChild!.type.name).toBe("blockquote");
  });
});

describe("collaboration", () => {
  test("every new command's steps pass the server's step validation", async () => {
    await loadMarkdown();
    const start = paragraphs("Title", "One", "Two", "");
    const h = new Harness(start, caret("Two", 3));
    h.type(" example.com ");
    h.run(insertHardBreak);
    h.type("https://palladian.dev/x");
    h.run(chainCommands(keys.Enter!, baseKeymap.Enter!));
    h.type("## ");
    h.run(backspace);
    h.dispatch(
      h.state.tr.delete(h.state.selection.from - 3, h.state.selection.from),
    );
    h.type("---").type("- item ");
    h.run(backspace);
    h.state = h.state.apply(
      h.state.tr.setSelection(
        TextSelection.create(
          h.state.doc,
          at(h.state.doc, "One"),
          at(h.state.doc, "Two", 3),
        ),
      ),
    );
    for (const kind of ["bullet", "checklist", "ordered", "ordered"] as const)
      h.run(applyListType(kind));
    h.run(applyListType("checklist"));
    h.run(toggleBlock(nodes.heading!, { level: 2 }));
    h.run(toggleBlock(nodes.heading!, { level: 2 }));
    h.state = h.state.apply(
      h.state.tr.setSelection(
        TextSelection.create(h.state.doc, at(h.state.doc, "Title", 5)),
      ),
    );
    h.run(insertDivider);
    const word = at(h.state.doc, "Title");
    h.dispatch(applyLink(h.state, word, word + 5, "Title", "https://t.dev")!);
    h.dispatch(removeLink(h.state, word, word + 5));
    h.state = h.state.apply(
      h.state.tr.setSelection(TextSelection.atEnd(h.state.doc)),
    );
    pasteMarkdown(
      h.view,
      {
        clipboardData: {
          getData: (type: string) =>
            type === "text/plain" ? "# Pasted\n\n- [ ] task\n\n> quote" : "",
        },
      } as unknown as ClipboardEvent,
      Slice.empty,
    );
    h.run(chainCommands(keys.Enter!, baseKeymap.Enter!));
    h.type("/divider").key("Enter");
    h.run(selectEnd);
    const types = new Set<string>();
    h.state.doc.descendants((node) => {
      types.add(node.type.name);
      for (const mark of node.marks) types.add(mark.type.name);
    });
    for (const name of [
      "task_list",
      "bullet_list",
      "heading",
      "blockquote",
      "horizontal_rule",
      "hard_break",
      "link",
    ])
      expect(types).toContain(name);
    h.replay(start);
  });
});

describe("lists under collaboration", () => {
  const cases: [
    string,
    string,
    (doc: ProseMirrorNode) => TextSelection,
    Command,
  ][] = [
    [
      "bullet item to checklist",
      "- a\n- b\n- c",
      caret("b"),
      applyListType("checklist"),
    ],
    [
      "paragraphs to bullets",
      "a\n\nb",
      select("a", "b"),
      applyListType("bullet"),
    ],
    [
      "bullets to paragraphs",
      "- a\n- b",
      select("a", "b"),
      applyListType("bullet"),
    ],
    [
      "checklist to numbered",
      "- [ ] a\n- [ ] b",
      caret("a"),
      applyListType("ordered"),
    ],
    [
      "paragraph and checklist",
      "a\n\n- [ ] b",
      select("a", "b"),
      applyListType("checklist"),
    ],
  ];
  const client = (doc: ProseMirrorNode, selection: TextSelection) =>
    EditorState.create({
      doc,
      selection,
      plugins: [collab({ version: 0, clientID: "me" })],
    });

  test.each(cases)(
    "%s keeps concurrent text in both rebase directions",
    (_name, markdown, selection, command) => {
      const doc = markdownToDoc(markdown);
      const remoteInsert = new Transform(doc).insert(
        at(doc, "b"),
        notesSchema.text("REMOTE "),
      );

      // An unconfirmed local list change, then a collaborator's typing arrives.
      let local = client(doc, selection(doc));
      expect(command(local, (tr) => (local = local.apply(tr)))).toBe(true);
      local = local.apply(
        receiveTransaction(
          local,
          remoteInsert.steps,
          remoteInsert.steps.map(() => "them"),
        ),
      );
      local.doc.check();
      expect(local.doc.textContent).toContain("REMOTE");

      // Unconfirmed local typing, then a collaborator's list change arrives.
      let typing = client(doc, TextSelection.create(doc, at(doc, "b")));
      typing = typing.apply(typing.tr.insertText("LOCAL ", at(doc, "b")));
      let change: Transaction | null = null;
      command(
        EditorState.create({ doc, selection: selection(doc) }),
        (tr) => (change = tr),
      );
      const steps = change!.steps;
      typing = typing.apply(
        receiveTransaction(
          typing,
          steps,
          steps.map(() => "them"),
        ),
      );
      typing.doc.check();
      expect(typing.doc.textContent).toContain("LOCAL");
    },
  );
});

describe("review round fixes", () => {
  test("link addresses may carry a port; other schemes stay refused", () => {
    expect(normalizeHref("example.com:8080/x")).toBe(
      "https://example.com:8080/x",
    );
    expect(normalizeHref("localhost:3000")).toBe("https://localhost:3000");
    expect(normalizeHref("javascript:alert(document.cookie)")).toBeNull();
    expect(normalizeHref("ftp://example.com")).toBeNull();
  });

  test("a URL at the end of a pasted line links exactly and the next line has no stray space", () => {
    const slice = markdownSlice(
      "Check this out\nhttps://example.com/page\nThanks",
      codec,
    )!;
    expect(slice.content.content.map((node) => node.textContent)).toEqual([
      "Check this out",
      "https://example.com/page",
      "Thanks",
    ]);
    expect(slice.content.child(1).firstChild!.marks[0]!.attrs.href).toBe(
      "https://example.com/page",
    );
  });

  test("pasted content stays within the server's limits", () => {
    const numbered = markdownSlice("1234567. item", codec)!;
    expect(numbered.content.firstChild!.attrs.order).toBe(1_000_000);
    const title = "t".repeat(600);
    const linked = markdownSlice(`[x](https://a.dev "${title}")`, codec)!;
    expect(
      linked.content.firstChild!.firstChild!.marks[0]!.attrs.title,
    ).toHaveLength(500);
    const odd = new Slice(
      nodes.doc!.create(null, [
        nodes.paragraph!.create({ id: "not valid!" }, notesSchema.text("x")),
      ]).content,
      0,
      0,
    );
    const safe = safeSlice(odd);
    expect(safe.content.firstChild!.attrs.id).toBeNull();
    for (const result of [numbered, linked, safe])
      assertSafeFragment(result.content);
    // The typed shortcut leaves a number the server would refuse as text.
    const typed = new Harness(paragraphs("")).type("1234567. ");
    expect(typed.state.doc.firstChild!.type.name).toBe("paragraph");
  });

  test("Palladian's own copies are not reparsed as Markdown", async () => {
    await loadMarkdown();
    const h = new Harness(paragraphs(""));
    const handled = pasteMarkdown(
      h.view,
      {
        clipboardData: {
          getData: (type: string) =>
            type === "text/plain"
              ? "1. Buy milk"
              : type === "text/html"
                ? '<p data-pm-slice="1 1 []">1. Buy milk</p>'
                : "",
        },
      } as unknown as ClipboardEvent,
      new Slice(paragraphs("1. Buy milk").content, 1, 1),
    );
    expect(handled).toBe(false);
  });

  test("iOS's em dash still makes a divider", () => {
    const h = new Harness(paragraphs("Above", "")).type("\u2014-");
    expect(shape(h.state.doc)).toEqual([
      { paragraph: ["Above"] },
      "horizontal_rule",
      "paragraph",
    ]);
  });
});

describe("review round 1", () => {
  /** A collaborative editor with the link form open on `word`. */
  function formOn(markdown: string, word: string) {
    const doc = markdownToDoc(markdown);
    const from = at(doc, word);
    const to = from + word.length;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
      plugins: [collab({ version: 0, clientID: "me" }), linkUi],
    });
    return state.apply(state.tr.setMeta(linkUiKey, { mode: "form", from, to }));
  }
  /** A collaborator's change arriving while the form is open. */
  function remote(state: EditorState, change: (tr: Transform) => void) {
    const tr = new Transform(state.doc);
    change(tr);
    const clients = tr.steps.map(() => "them");
    return state.apply(receiveTransaction(state, tr.steps, clients));
  }
  /** Apply the form as the editor does. */
  function applyForm(state: EditorState, text: string, textEdited: boolean) {
    const target = linkUiKey.getState(state)!;
    return applyLink(state, target.from, target.to, text, "https://e.com", {
      textEdited,
      touched: !!target.touched,
    });
  }
  function linkedText(doc: ProseMirrorNode) {
    let text = "";
    doc.descendants((node) => {
      if (node.isText && marks.link!.isInSet(node.marks)) text += node.text;
    });
    return text;
  }

  test("F1: an unchanged label links the text as collaborators left it", () => {
    const base = formOn("say hello there", "hello");
    const start = at(base.doc, "hello");
    const changes: [string, (tr: Transform) => void, string][] = [
      [
        "insertion",
        (tr) => tr.insert(start + 2, notesSchema.text("REMOTE")),
        "heREMOTEllo",
      ],
      ["deletion", (tr) => tr.delete(start + 1, start + 4), "ho"],
      [
        "replacement",
        (tr) => tr.replaceWith(start + 1, start + 4, notesSchema.text("ELL")),
        "hELLo",
      ],
    ];
    for (const [, change, expected] of changes) {
      const state = remote(base, change);
      const after = state.apply(applyForm(state, "hello", false)!);
      expect(after.doc.textContent).toBe(`say ${expected} there`);
      expect(linkedText(after.doc)).toBe(expected);
      expect(linkUiKey.getState(state)!.touched).toBe(true);
    }
  });

  test("F1: an edited label is not written over a collaborator's change", () => {
    const base = formOn("say hello there", "hello");
    const start = at(base.doc, "hello");
    const changed = remote(base, (tr) =>
      tr.insert(start + 2, notesSchema.text("REMOTE")),
    );
    expect(applyForm(changed, "Greetings", true)).toBeNull();
    // With no overlapping change, the edited label replaces the text.
    const quiet = remote(base, (tr) => tr.insert(1, notesSchema.text("Oh, ")));
    expect(linkUiKey.getState(quiet)!.touched).toBe(false);
    const after = quiet.apply(applyForm(quiet, "Greetings", true)!);
    expect(after.doc.textContent).toBe("Oh, say Greetings there");
    expect(linkedText(after.doc)).toBe("Greetings");
  });

  test("F1: text deleted while the form was open is not brought back", () => {
    const base = formOn("say hello there", "hello");
    const start = at(base.doc, "hello");
    const gone = remote(base, (tr) => tr.delete(start, start + 5));
    expect(applyForm(gone, "hello", false)).toBeNull();
    expect(gone.doc.textContent).toBe("say  there");
  });

  test.each([
    [
      "the first item of a list starting at 1,000,000",
      "1000000. a\n2. b",
      "a",
      "checklist",
    ],
    [
      "a middle item near the ceiling",
      "999999. a\n2. b\n3. c",
      "b",
      "checklist",
    ],
    [
      "numbering turned off for the first item",
      "1000000. a\n2. b",
      "a",
      "ordered",
    ],
  ] as const)(
    "F2: %s stays within the server's list start",
    (_name, markdown, word, kind) => {
      const start = markdownToDoc(markdown);
      const h = new Harness(start, caret(word));
      expect(h.run(applyListType(kind))).toBe(true);
      h.state.doc.descendants((node) => {
        if (node.type === nodes.ordered_list)
          expect(node.attrs.order).toBeLessThanOrEqual(1_000_000);
      });
      h.replay(start);
    },
  );

  test("F3: a thematic break after a heading stays a divider", () => {
    expect(
      shape(
        nodes.doc!.create(
          null,
          markdownSlice("# Title\n\n---\nbelow", codec)!.content,
        ),
      ),
    ).toEqual([
      { heading: ["Title"] },
      "horizontal_rule",
      { paragraph: ["below"] },
    ]);
  });

  test("F3: code fenced inside a quote or a list item keeps its exact text", () => {
    const quoted = markdownSlice(
      "> ```js\n> let a = 1;\n> let b = 2;\n> ```\n\n**x**",
      codec,
    )!;
    const quote = quoted.content.firstChild!;
    expect(quote.type.name).toBe("blockquote");
    expect(quote.firstChild!.textContent).toBe("let a = 1;\nlet b = 2;");
    const listed = markdownSlice(
      "- item\n\n  ```\n  code\n  more\n  ```",
      codec,
    )!;
    let code = "";
    listed.content.descendants((node) => {
      if (node.type === nodes.code_block) code = node.textContent;
    });
    expect(code).toBe("code\nmore");
  });

  test("F3: literal U+E000 characters and explicit line breaks are kept", () => {
    const literal = markdownSlice("**a** \ue000 b\nnext", codec)!;
    expect(literal.content.textBetween(0, literal.content.size, "|")).toBe(
      "a \ue000 b next",
    );
    const broken = markdownSlice("foo  \nbar **x**", codec)!;
    expect(shape(nodes.doc!.create(null, broken.content))).toEqual([
      { paragraph: ["foo", "hard_break", "bar ", "x"] },
    ]);
  });

  test("F3: ordinary lines still stay separate lines", () => {
    const slice = markdownSlice("first line\nsecond **line**\n- item", codec)!;
    expect(slice.content.content.map((node) => node.textContent)).toEqual([
      "first line",
      "second line",
      "item",
    ]);
  });
});

describe("review round 2", () => {
  const link = marks.link!;
  function linkedText(doc: ProseMirrorNode) {
    let text = "";
    doc.descendants((node) => {
      if (node.isText && link.isInSet(node.marks)) text += node.text;
    });
    return text;
  }
  /** A collaborative editor at version 0 of `doc`, with the link form plugin. */
  function client(doc: ProseMirrorNode) {
    return EditorState.create({
      doc,
      plugins: [collab({ version: 0, clientID: "me" }), linkUi],
    });
  }
  /** Open the link form on `word`, as the editor does. */
  function openForm(state: EditorState, word: string) {
    const from = at(state.doc, word);
    const to = from + word.length;
    return state.apply(
      state.tr
        .setSelection(TextSelection.create(state.doc, from, to))
        .setMeta(linkUiKey, { mode: "form", from, to }),
    );
  }
  /** A collaborator's steps, built on the last confirmed document. */
  function receive(
    state: EditorState,
    confirmed: ProseMirrorNode,
    change: (tr: Transform) => void,
  ) {
    const tr = new Transform(confirmed);
    change(tr);
    const clients = tr.steps.map(() => "them");
    return state.apply(receiveTransaction(state, tr.steps, clients));
  }
  function applyForm(state: EditorState, text: string, textEdited: boolean) {
    const target = linkUiKey.getState(state)!;
    return applyLink(state, target.from, target.to, text, "https://e.com", {
      textEdited,
      touched: !!target.touched,
    });
  }

  test("R2-1: the form keeps unconfirmed text it was opened on through a rebase", () => {
    const confirmed = markdownToDoc("say  there");
    let state = client(confirmed);
    // Typed locally, not yet confirmed by the server.
    state = state.apply(state.tr.insertText("hello", at(confirmed, "say ", 4)));
    state = openForm(state, "hello");
    const opened = linkUiKey.getState(state)!;
    state = receive(state, confirmed, (tr) =>
      tr.insert(1, notesSchema.text("Oh, ")),
    );
    expect(linkUiKey.getState(state)).toEqual({
      mode: "form",
      from: opened.from + 4,
      to: opened.to + 4,
      touched: false,
    });
    const after = state.apply(applyForm(state, "hello", false)!);
    expect(after.doc.textContent).toBe("Oh, say hello there");
    expect(linkedText(after.doc)).toBe("hello");
  });

  test("R2-1: a pending local edit inside the range is not a collaborator's change", () => {
    const confirmed = markdownToDoc("say hello there");
    let state = client(confirmed);
    state = state.apply(state.tr.insertText("X", at(confirmed, "hello", 2)));
    state = openForm(state, "heXllo");
    state = receive(state, confirmed, (tr) =>
      tr.insert(1, notesSchema.text("Oh, ")),
    );
    expect(linkUiKey.getState(state)!.touched).toBe(false);
    // An edited label may replace it, since nobody else changed it.
    const after = state.apply(applyForm(state, "Greetings", true)!);
    expect(after.doc.textContent).toBe("Oh, say Greetings there");
    expect(linkedText(after.doc)).toBe("Greetings");
  });

  test("R2-1: a collaborator's change inside the range still counts with local steps pending", () => {
    const confirmed = markdownToDoc("say hello there");
    let state = client(confirmed);
    state = state.apply(state.tr.insertText("X", at(confirmed, "hello", 2)));
    state = openForm(state, "heXllo");
    const inside = at(confirmed, "hello", 4);
    state = receive(state, confirmed, (tr) =>
      tr.insert(inside, notesSchema.text("R")),
    );
    expect(linkUiKey.getState(state)!.touched).toBe(true);
    expect(applyForm(state, "Greetings", true)).toBeNull();
    const after = state.apply(applyForm(state, "heXllo", false)!);
    expect(after.doc.textContent).toBe("say heXllRo there");
    expect(linkedText(after.doc)).toBe("heXllRo");
  });

  test("R2-2: a paste with a very long run of spaces is parsed quickly", () => {
    const text = "**x**\n" + " ".repeat(64_000) + "code";
    const started = performance.now();
    const slice = markdownSlice(text, codec);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(slice).not.toBeNull();
  });

  test.each([
    ["hexadecimal", "**a**&#xE000;b\nnext"],
    ["decimal", "**a**&#57344;b\nnext"],
  ])("R2-3: a U+E000 written as a %s entity is kept", (_name, text) => {
    const slice = markdownSlice(text, codec)!;
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild!.textContent).toBe("a\ue000b next");
  });
});

describe("review round 3", () => {
  const link = marks.link!;
  function linkedText(doc: ProseMirrorNode) {
    let text = "";
    doc.descendants((node) => {
      if (node.isText && link.isInSet(node.marks)) text += node.text;
    });
    return text;
  }
  /**
   * A collaborative editor with a local, unconfirmed edit, the link form
   * opened on `word` as the editor opens it, and then a collaborator's steps
   * (built on the confirmed document) received through prosemirror-collab.
   */
  function rebasedForm(
    markdown: string,
    local: (state: EditorState, start: number) => Transaction,
    word: string,
    remote: (tr: Transform, start: number) => void,
  ) {
    const confirmed = markdownToDoc(markdown);
    const start = at(confirmed, markdown);
    let state = EditorState.create({
      doc: confirmed,
      plugins: [collab({ version: 0, clientID: "me" }), linkUi],
    });
    state = state.apply(local(state, start));
    const from = at(state.doc, word);
    const to = from + word.length;
    state = state.apply(
      state.tr.setMeta(linkUiKey, {
        mode: "form",
        from,
        to,
        content: state.doc.slice(from, to).content,
      }),
    );
    const theirs = new Transform(confirmed);
    remote(theirs, start);
    const clients = theirs.steps.map(() => "them");
    return state.apply(receiveTransaction(state, theirs.steps, clients));
  }
  function applyForm(state: EditorState, text: string, textEdited: boolean) {
    const target = linkUiKey.getState(state)!;
    return applyLink(state, target.from, target.to, text, "https://e.com", {
      textEdited,
      touched: !!target.touched,
      original: target.content,
    });
  }
  const cases: [
    string,
    (state: EditorState, start: number) => Transaction,
    string,
    (tr: Transform, start: number) => void,
    string,
  ][] = [
    [
      "a replaced first letter and an insertion after it",
      (state, start) => state.tr.insertText("XYZ", start, start + 1),
      "YZb",
      (tr, start) => tr.insert(start + 1, notesSchema.text("REMOTE")),
      "REMOTE",
    ],
    [
      "a partly replayed replacement",
      (state, start) => state.tr.insertText("XYZ", start, start + 3),
      "YZd",
      (tr, start) => {
        tr.delete(start + 1, start + 2);
        tr.insert(start + 2, notesSchema.text("R"));
      },
      "R",
    ],
  ];

  test.each(cases)(
    "R3-1: %s — an edited label is refused",
    (_name, local, word, remote, theirs) => {
      const state = rebasedForm("abcdef", local, word, remote);
      expect(state.doc.textContent).toContain(theirs);
      expect(applyForm(state, "Greeting", true)).toBeNull();
      // Linking without editing the text only adds the mark, keeping theirs.
      const after = state.apply(applyForm(state, word, false)!);
      expect(after.doc.textContent).toBe(state.doc.textContent);
      expect(linkedText(after.doc)).toContain(theirs);
    },
  );

  test("R3-1: an edited label still applies when the text is as it was", () => {
    const state = rebasedForm(
      "abcdef",
      (s, start) => s.tr.insertText("XYZ", start, start + 1),
      "YZb",
      (tr, start) => tr.insert(start + 5, notesSchema.text("REMOTE")),
    );
    const after = state.apply(applyForm(state, "Greeting", true)!);
    expect(after.doc.textContent).toBe("XGreetingcdeREMOTEf");
    expect(linkedText(after.doc)).toBe("Greeting");
  });

  function codeTexts(fragment: Fragment) {
    const texts: string[] = [];
    fragment.descendants((node) => {
      if (node.type === nodes.code_block) texts.push(node.textContent);
    });
    return texts;
  }
  test.each([
    [
      "a quote inside a list item",
      "- > ```\n  > code\n  > more\n  > ```\n- next **x**\n  line",
    ],
    [
      "several list markers",
      "- - ```\n    code\n    more\n    ```\n\n**x**\nline",
    ],
    ["fence text in indented code", "para **x**\n\n    ```\n    code\n    ```"],
    ["a backtick in the info string", "``` a`b\ncode\nmore\n```\n**x**\nline"],
    ["a fence ended by its quote", "> ```\n> code\n\nafter **x**\nline two"],
    ["a tilde fence", "~~~\na\nb\n~~~\n**x**\nline"],
  ])("R3-2: %s keeps code exactly as the parser reads it", (_name, text) => {
    const slice = markdownSlice(text, codec)!;
    expect(codeTexts(slice.content)).toEqual(
      codeTexts(parseMarkdownFragment(text)),
    );
    expect(
      slice.content.textBetween(0, slice.content.size, "\n"),
    ).not.toContain("\ue000");
  });
});

describe("review round 4", () => {
  /** A collaborative editor with the link form open on `word`, as the editor opens it. */
  function formOn(markdown: string, word: string) {
    const doc = markdownToDoc(markdown);
    const from = at(doc, word);
    const to = from + word.length;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
      plugins: [collab({ version: 0, clientID: "me" }), linkUi],
    });
    return state.apply(
      state.tr.setMeta(linkUiKey, {
        mode: "form",
        from,
        to,
        content: doc.slice(from, to).content,
      }),
    );
  }
  function remote(state: EditorState, change: (tr: Transform) => void) {
    const tr = new Transform(state.doc);
    change(tr);
    const clients = tr.steps.map(() => "them");
    return state.apply(receiveTransaction(state, tr.steps, clients));
  }
  function applyForm(state: EditorState, text: string, textEdited: boolean) {
    const target = linkUiKey.getState(state)!;
    return applyLink(state, target.from, target.to, text, "https://e.com", {
      textEdited,
      touched: !!target.touched,
      original: target.content,
    });
  }
  /** The editor's reload after a refused Apply: the form takes the current content. */
  function reload(state: EditorState) {
    const target = linkUiKey.getState(state)!;
    return state.apply(
      state.tr.setMeta(linkUiKey, {
        ...target,
        touched: false,
        content: state.doc.slice(target.from, target.to).content,
      }),
    );
  }

  test("R4-1: a target a collaborator turned into code is refused and left as it is", () => {
    const base = formOn("abcdef", "bcde");
    const state = remote(base, (tr) =>
      tr.setBlockType(1, 1, nodes.code_block!),
    );
    expect(state.doc.firstChild!.type.name).toBe("code_block");
    expect(applyForm(state, "Greeting", true)).toBeNull();
    expect(applyForm(state, "bcde", false)).toBeNull();
    const target = linkUiKey.getState(state)!;
    expect(linkable(state, target.from, target.to)).toBe(false);
  });

  test("R4-1: a target split across paragraphs is refused, also after a reload", () => {
    const base = formOn("abcdef", "bcde");
    const state = remote(base, (tr) => tr.split(at(base.doc, "def")));
    expect(state.doc.childCount).toBe(2);
    expect(applyForm(state, "Greeting", true)).toBeNull();
    const reloaded = reload(state);
    expect(applyForm(reloaded, "Greeting", true)).toBeNull();
    expect(applyForm(reloaded, "bc", false)).toBeNull();
    const target = linkUiKey.getState(reloaded)!;
    expect(linkable(reloaded, target.from, target.to)).toBe(false);
    expect(reloaded.doc.childCount).toBe(2);
  });

  test("R4-1: the form opens only where a link can go", () => {
    const code = new Harness(
      markdownToDoc("```\nabc\n```"),
      select("abc", "abc"),
    );
    expect(linkDraftFor(code.state)).toBeNull();
    const across = new Harness(paragraphs("One", "Two"), select("One", "Two"));
    expect(linkDraftFor(across.state)).toBeNull();
    const inline = new Harness(
      markdownToDoc("a `code` b"),
      select("code", "code"),
    );
    expect(linkDraftFor(inline.state)).toBeNull();
    const plain = new Harness(
      paragraphs("plain words"),
      select("plain", "plain"),
    );
    expect(linkDraftFor(plain.state)).not.toBeNull();
    const doc = plain.state.doc;
    expect(linkable(plain.state, at(doc, "plain"), at(doc, "words", 5))).toBe(
      true,
    );
  });
});

describe("review round 5", () => {
  test("R5-1: inline code switched on at the caret keeps a link out", () => {
    const h = new Harness(paragraphs("abc"));
    // What the Inline code button does with an empty selection.
    h.dispatch(h.state.tr.addStoredMark(marks.code!.create()));
    const { from } = h.state.selection;
    expect(
      applyLink(h.state, from, from, "Site", "https://example.com"),
    ).toBeNull();
    expect(linkDraftFor(h.state)).toBeNull();
    expect(keys["Mod-k"]!(h.state)).toBe(false);
    expect(linkable(h.state, from, from)).toBe(false);
  });

  test("R5-1: without pending inline code the same caret takes a link", () => {
    const h = new Harness(paragraphs("abc"));
    h.dispatch(h.state.tr.addStoredMark(marks.code!.create()));
    h.dispatch(h.state.tr.removeStoredMark(marks.code!));
    const { from } = h.state.selection;
    expect(linkDraftFor(h.state)).not.toBeNull();
    h.dispatch(applyLink(h.state, from, from, "Site", "https://example.com")!);
    const site = h.state.doc.firstChild!.lastChild!;
    expect(site.text).toBe("Site");
    expect(site.marks.map((mark) => mark.type.name)).toEqual(["link"]);
  });
});
