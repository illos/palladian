import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { parseStoredDoc } from "@palladian/notes-core/document";
import { assignBlockIds, blockIdPlugin } from "@palladian/notes-core/ids";
import { isSafeHref, notesSchema } from "@palladian/notes-core/schema";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import {
  EditorState,
  Plugin,
  type Command,
  type Transaction,
} from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  type NodeViewConstructor,
} from "prosemirror-view";
import { baseKeymap, chainCommands, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { InputRule, inputRules, undoInputRule } from "prosemirror-inputrules";
import { collab } from "prosemirror-collab";
import { canJoin, findWrapping, Step } from "prosemirror-transform";
import type {
  Attrs,
  MarkType,
  Node as ProseMirrorNode,
  NodeType,
} from "prosemirror-model";
import type { EditorBinding } from "./binding";
import {
  applyListType,
  blockActive,
  currentListKind,
  dividerRule,
  endSelection,
  insertDivider,
  insertHardBreak,
  quoteActive,
  selectEnd,
  setBlock,
  toggleBlock,
  toggleQuote,
  type ListKind,
} from "./editor-commands";
import {
  applyLink,
  autolinkOnSpace,
  linkBeforeCaret,
  linkDraftFor,
  linkRangeAt,
  linkable,
  linkUi,
  linkUiKey,
  normalizeHref,
  type LinkUi,
  removeLink,
  unlinkAtEdge,
} from "./editor-links";
import {
  loadMarkdown,
  pasteMarkdown,
  safeSlice,
  sanitizePastedHtml,
  serializeClipboardText,
} from "./editor-clipboard";
import { runSlash, slashChoices, slashKey, slashPalette } from "./editor-slash";

export { notesSchema };
export function validateDocument(document: string) {
  return parseStoredDoc(document);
}
export { emptyDocument, textDocument } from "./document";

type Tool = {
  label: string;
  glyph?: ReactNode;
  command: Command;
  active?: (state: EditorState) => boolean;
  /** The Link tool opens the link form rather than running its command. */
  opensLinkForm?: boolean;
};
type ToolGroup = "Style" | "Format" | "Lists";

// Geometry from the read-only Deltos icon reference; only supported editor tools.
function EditorGlyph({
  name,
}: {
  name:
    | "undo"
    | "redo"
    | "code"
    | "bullet-list"
    | "numbered-list"
    | "quote"
    | "checklist"
    | "link"
    | "divider";
}) {
  const numberedStyle = {
    fontSize: "7px",
    fontFamily: "'IBM Plex Mono', monospace",
    fill: "currentColor",
    stroke: "none",
  } as const;
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={
        name === "undo" ||
        name === "redo" ||
        name === "code" ||
        name === "divider"
          ? 1.7
          : 1.6
      }
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "undo" ? (
        <>
          <path d="M4 10h10a5 5 0 0 1 0 10h-4" />
          <path d="M8 6l-4 4 4 4" />
        </>
      ) : name === "redo" ? (
        <>
          <path d="M20 10H10a5 5 0 0 0 0 10h4" />
          <path d="M16 6l4 4-4 4" />
        </>
      ) : name === "code" ? (
        <>
          <path d="M9 8l-4 4 4 4" />
          <path d="M15 8l4 4-4 4" />
        </>
      ) : name === "link" ? (
        <>
          <path d="M10 13a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1.2 1.2" />
          <path d="M14 11a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.2-1.2" />
        </>
      ) : name === "divider" ? (
        <line x1="4" y1="12" x2="20" y2="12" />
      ) : name === "checklist" ? (
        <>
          <rect x="3" y="4.5" width="5" height="5" rx="1" />
          <path d="M4.2 7.1l1.2 1.2 2-2.3" />
          <rect x="3" y="14.5" width="5" height="5" rx="1" />
          <line x1="11" y1="7" x2="20" y2="7" />
          <line x1="11" y1="17" x2="20" y2="17" />
        </>
      ) : name === "quote" ? (
        <>
          <path d="M7 7H4v4c0 2 1 3 3 3" />
          <path d="M16 7h-3v4c0 2 1 3 3 3" />
        </>
      ) : (
        <>
          <line x1="9" y1="6.5" x2="20" y2="6.5" />
          <line x1="9" y1="12" x2="20" y2="12" />
          <line x1="9" y1="17.5" x2="20" y2="17.5" />
          {name === "bullet-list" ? (
            <>
              <circle
                cx="4.5"
                cy="6.5"
                r="1.4"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="4.5"
                cy="12"
                r="1.4"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="4.5"
                cy="17.5"
                r="1.4"
                fill="currentColor"
                stroke="none"
              />
            </>
          ) : (
            <>
              <text x="2" y="9" style={numberedStyle}>
                1
              </text>
              <text x="2.6" y="14.4" style={numberedStyle}>
                2
              </text>
              <text x="2.4" y="20" style={numberedStyle}>
                3
              </text>
            </>
          )}
        </>
      )}
    </svg>
  );
}
const boldGlyph = <strong style={{ fontWeight: 600 }}>B</strong>;
const strikeGlyph = (
  <span style={{ textDecoration: "line-through", fontWeight: 500 }}>S</span>
);
const italicGlyph = <em style={{ fontFamily: "Georgia, serif" }}>I</em>;

const {
  heading,
  paragraph,
  code_block,
  bullet_list,
  ordered_list,
  task_list,
  list_item,
  task_item,
  blockquote,
} = notesSchema.nodes as Record<string, NodeType>;
const marks = notesSchema.marks as Record<string, MarkType>;

function markActive(state: EditorState, name: string) {
  const mark = notesSchema.marks[name]!;
  return state.selection.empty
    ? !!mark.isInSet(state.storedMarks ?? state.selection.$from.marks())
    : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark);
}

/** Commands shared by the toolbar, the keyboard and the slash palette. */
const styles = {
  title: toggleBlock(heading!, { level: 1 }),
  heading: toggleBlock(heading!, { level: 2 }),
  subhead: toggleBlock(heading!, { level: 3 }),
  body: setBlock(paragraph!),
  mono: toggleBlock(code_block!),
};
const inlineCode = toggleMark(marks.code!);
/** The Link tool and Mod-K are available where the link form can apply. */
const canLink: Command = (state) => linkDraftFor(state) !== null;

function styleTool(
  label: string,
  command: Command,
  type: string,
  level?: number,
): Tool {
  return {
    label,
    command,
    active: (state) =>
      blockActive(state, notesSchema.nodes[type]!, level ? { level } : {}),
  };
}
function listTool(label: string, kind: ListKind, glyph: ReactNode): Tool {
  return {
    label,
    glyph,
    command: applyListType(kind),
    active: (state) => currentListKind(state) === kind,
  };
}
const toolGroups: Record<ToolGroup, Tool[]> = {
  Style: [
    styleTool("Title", styles.title, "heading", 1),
    styleTool("Heading", styles.heading, "heading", 2),
    styleTool("Subhead", styles.subhead, "heading", 3),
    styleTool("Body", styles.body, "paragraph"),
    styleTool("Mono", styles.mono, "code_block"),
  ],
  Format: [
    {
      label: "Bold",
      glyph: boldGlyph,
      command: toggleMark(marks.strong!),
      active: (state) => markActive(state, "strong"),
    },
    {
      label: "Italic",
      glyph: italicGlyph,
      command: toggleMark(marks.em!),
      active: (state) => markActive(state, "em"),
    },
    {
      label: "Strikethrough",
      glyph: strikeGlyph,
      command: toggleMark(marks.strike!),
      active: (state) => markActive(state, "strike"),
    },
    {
      label: "Inline code",
      glyph: <EditorGlyph name="code" />,
      command: inlineCode,
      active: (state) => markActive(state, "code"),
    },
    {
      label: "Link",
      glyph: <EditorGlyph name="link" />,
      command: canLink,
      active: (state) => markActive(state, "link"),
      opensLinkForm: true,
    },
  ],
  Lists: [
    listTool("Bulleted list", "bullet", <EditorGlyph name="bullet-list" />),
    listTool("Numbered list", "ordered", <EditorGlyph name="numbered-list" />),
    listTool("Checklist", "checklist", <EditorGlyph name="checklist" />),
    {
      label: "Quote",
      glyph: <EditorGlyph name="quote" />,
      command: toggleQuote,
      active: quoteActive,
    },
    {
      label: "Divider",
      glyph: <EditorGlyph name="divider" />,
      command: insertDivider,
    },
  ],
};
const historyTools: Tool[] = [
  { label: "Undo", glyph: <EditorGlyph name="undo" />, command: undo },
  { label: "Redo", glyph: <EditorGlyph name="redo" />, command: redo },
];

/** Inline Markdown shortcuts: **bold**, *italic*, `code`, ~~strike~~. */
function markRule(pattern: RegExp, type: MarkType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (!text) return null;
    const $start = state.doc.resolve(start);
    if ($start.parent.type.spec.code) return null;
    const tr = state.tr.replaceWith(
      start,
      end,
      notesSchema.text(text, [type.create()]),
    );
    return tr.removeStoredMark(type);
  });
}

/** `#HEADER` then Tab makes a heading (confirmed behavior). */
const hashHeading: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const text = $from.parent.textContent;
  const match = /^(#{1,3})(.+)$/.exec(text);
  if (
    !match ||
    $from.parent.type !== paragraph ||
    $from.parentOffset !== text.length
  )
    return false;
  if (dispatch) {
    const tr = state.tr.delete($from.start(), $from.start() + match[1]!.length);
    tr.setBlockType(
      $from.before(),
      $from.before() + tr.doc.nodeAt($from.before())!.nodeSize,
      heading!,
      { level: match[1]!.length },
    );
    dispatch(tr);
  }
  return true;
};

/** Three backticks then Enter starts a code block. */
const fenceToCode: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const match = /^```([\w-]{0,40})$/.exec($from.parent.textContent);
  if (!match || $from.parent.type !== paragraph) return false;
  if (dispatch) {
    const tr = state.tr.delete($from.start(), $from.end());
    tr.setBlockType($from.before(), $from.before() + 2, code_block!, {
      language: match[1] ?? "",
    });
    dispatch(tr);
  }
  return true;
};

const taskView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement("li");
  dom.className = "task-item";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!node.attrs.checked;
  box.contentEditable = "false";
  box.setAttribute("aria-label", "Done");
  box.addEventListener("mousedown", (event) => event.preventDefault());
  box.addEventListener("click", (event) => {
    event.preventDefault();
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    view.dispatch(
      view.state.tr.setNodeAttribute(pos, "checked", !node.attrs.checked),
    );
  });
  const content = document.createElement("div");
  dom.append(box, content);
  dom.dataset.checked = String(!!node.attrs.checked);
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      box.checked = !!next.attrs.checked;
      dom.dataset.checked = String(!!next.attrs.checked);
      return true;
    },
    ignoreMutation: (mutation) =>
      mutation.type === "attributes" || mutation.target === box,
  };
};

/**
 * New blocks from a shortcut get their IDs in the same transaction. A
 * separate ID repair afterwards would end Backspace's chance to undo it.
 */
function withIds(tr: Transaction | null) {
  if (tr) assignBlockIds(tr);
  return tr;
}
/** `# ` to `### `: the block becomes a heading and keeps its ID. */
function blockTypeRule(
  pattern: RegExp,
  type: NodeType,
  attrs: (match: RegExpMatchArray) => Attrs,
) {
  return new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const index = $start.index(-1);
    if (!$start.node(-1).canReplaceWith(index, $start.indexAfter(-1), type))
      return null;
    return state.tr
      .delete(start, end)
      .setBlockType(start, start, type, (old) => ({
        ...attrs(match),
        id: old.attrs.id,
      }));
  });
}
/** `- `, `1. `, `[ ] ` and `> ` wrap the block (prosemirror-inputrules' `wrappingInputRule`, with IDs). */
function wrapRule(
  pattern: RegExp,
  type: NodeType,
  attrs?: (match: RegExpMatchArray) => Attrs,
  join?: (match: RegExpMatchArray, node: ProseMirrorNode) => boolean,
) {
  return new InputRule(pattern, (state, match, start, end) => {
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    const wrapping =
      range && findWrapping(range, type, attrs ? attrs(match) : null);
    if (!range || !wrapping) return null;
    tr.wrap(range, wrapping);
    const before = tr.doc.resolve(start - 1).nodeBefore;
    if (
      before?.type === type &&
      canJoin(tr.doc, start - 1) &&
      (!join || join(match, before))
    )
      tr.join(start - 1);
    return withIds(tr);
  });
}

/**
 * Markdown shortcuts typed at the start of a block or around a word, `---`
 * for a divider, and links typed before a space. Backspace straight after any
 * of them restores the typed text (`undoInputRule`).
 */
export const markdownShortcuts = inputRules({
  rules: [
    blockTypeRule(/^(#{1,3})\s$/, heading!, (match) => ({
      level: match[1]!.length,
    })),
    wrapRule(/^\s*([-+*])\s$/, bullet_list!),
    // Up to six digits: the server accepts list starts up to 1,000,000.
    wrapRule(
      /^(\d{1,6})\.\s$/,
      ordered_list!,
      (match) => ({ order: Number(match[1]) }),
      (match, node) =>
        node.childCount + Number(node.attrs.order) === Number(match[1]),
    ),
    wrapRule(/^\[( |x)?\]\s$/, task_list!),
    wrapRule(/^\s*>\s$/, blockquote!),
    // iOS Smart Punctuation turns "--" into an em dash before the third "-".
    new InputRule(/^(?:---|\u2014-)$/, (state, _match, start, end) =>
      withIds(dividerRule(state, start, end)),
    ),
    markRule(/\*\*([^*]+)\*\*$/, marks.strong!),
    // The lookbehind keeps the preceding character out of the match, so
    // only the delimiters are replaced.
    markRule(/(?<!\*)\*([^*]+)\*$/, marks.em!),
    markRule(/~~([^~]+)~~$/, marks.strike!),
    markRule(/`([^`]+)`$/, marks.code!),
    autolinkOnSpace,
  ],
});

/** Enter: a code fence, then a new checklist item (always unchecked) or list item. */
export const enterKey: Command = chainCommands(
  fenceToCode,
  splitListItem(task_item!, { checked: false }),
  splitListItem(list_item!),
);

/** Enter after a URL links it, then breaks the line as usual. */
export const enterWithLinks: Command = (state, dispatch, view) => {
  if (dispatch && view && linkBeforeCaret(state, view.dispatch)) {
    chainCommands(enterKey, baseKeymap.Enter!)(view.state, view.dispatch, view);
    return true;
  }
  return enterKey(state, dispatch, view);
};

/** Key bindings. `openLink` shows the link form for Mod-K. */
export function editorKeys(
  openLink: (view: EditorView) => void,
): Record<string, Command> {
  const link: Command = (state, dispatch, view) => {
    if (!canLink(state)) return false;
    if (dispatch && view) openLink(view);
    return true;
  };
  return {
    "Mod-z": undo,
    "Mod-Shift-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(marks.strong!),
    "Mod-i": toggleMark(marks.em!),
    "Mod-Shift-x": toggleMark(marks.strike!),
    "Mod-e": inlineCode,
    "Mod-`": inlineCode,
    "Mod-k": link,
    Enter: enterWithLinks,
    "Shift-Enter": insertHardBreak,
    // Undo a shortcut first, then unlink at a link's end, then the base keymap.
    Backspace: chainCommands(undoInputRule, unlinkAtEdge),
    Tab: chainCommands(
      hashHeading,
      sinkListItem(list_item!),
      sinkListItem(task_item!),
    ),
    "Shift-Tab": chainCommands(
      liftListItem(list_item!),
      liftListItem(task_item!),
    ),
    "Mod-Alt-0": styles.body,
    "Mod-Alt-1": styles.title,
    "Mod-Alt-2": styles.heading,
    "Mod-Alt-3": styles.subhead,
    "Mod-Alt-c": styles.mono,
    // Shift-. reports ">" on most layouts; bind both names.
    "Mod-Shift-.": toggleQuote,
    "Mod-Shift->": toggleQuote,
  };
}

/** An empty first line shows "Title" (CSS) without any text in the note (D80). */
export const titlePlaceholder = new Plugin({
  props: {
    decorations(state) {
      const first = state.doc.firstChild;
      if (
        !first ||
        (first.type !== paragraph && first.type !== heading) ||
        first.content.size > 0
      )
        return null;
      return DecorationSet.create(state.doc, [
        Decoration.node(0, first.nodeSize, {
          class: "title-placeholder",
          "data-placeholder": "Title",
        }),
      ]);
    },
  },
});

type EditorHooks = {
  openLink: (view: EditorView) => void;
  slashEnabled: () => boolean;
};

function plugins(
  binding: EditorBinding | undefined,
  hooks: EditorHooks,
): Plugin[] {
  const list = [
    ...(binding
      ? [collab({ version: binding.version, clientID: binding.clientId })]
      : []),
    blockIdPlugin((tr) => tr.getMeta("rebased") !== undefined),
    history(),
    slashPalette({ enabled: hooks.slashEnabled, openLink: hooks.openLink }),
    linkUi,
    titlePlaceholder,
    markdownShortcuts,
    keymap(editorKeys(hooks.openLink)),
    keymap(baseKeymap),
  ];
  return list;
}

/** The link form's fields; `textEdited` once the person changes the Text field. */
type LinkForm = {
  text: string;
  href: string;
  error: string;
  textEdited: boolean;
};

/** The link element a click landed on, if it is in this editor. */
function linkElement(view: EditorView, event: MouseEvent) {
  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  return anchor && view.dom.contains(anchor) ? anchor : null;
}

export function NoteEditor({
  document,
  editedLabel,
  editable,
  onChange,
  binding,
}: {
  document: string;
  editedLabel?: string | undefined;
  editable: boolean;
  onChange: (document: string, text: string) => void;
  binding?: EditorBinding | undefined;
}) {
  const [toolbarState, setToolbarState] = useState<EditorState | null>(null);
  const [mobileGroup, setMobileGroup] = useState<ToolGroup | null>(null);
  const [linkForm, setLinkForm] = useState<LinkForm | null>(null);
  /** A short note after the link form closed on its own. */
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const linkText = useRef<HTMLInputElement>(null);
  const linkHref = useRef<HTMLInputElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  /** Show the link form for the selection or the link under the caret. */
  const openLinkForm = (editor: EditorView) => {
    const draft = linkDraftFor(editor.state);
    if (!draft || !editor.editable) return;
    editor.dispatch(
      editor.state.tr.setMeta(linkUiKey, {
        mode: "form",
        from: draft.from,
        to: draft.to,
        content: editor.state.doc.slice(draft.from, draft.to).content,
      } satisfies LinkUi),
    );
    // Render now so focus moves within the tap or key press (iOS keyboard).
    flushSync(() => {
      setLinkNotice(null);
      setLinkForm({
        text: draft.text,
        href: draft.href,
        error: "",
        textEdited: false,
      });
    });
    (draft.text ? linkHref : linkText).current?.focus();
  };
  const openLink = useRef(openLinkForm);
  openLink.current = openLinkForm;
  useEffect(() => {
    if (!host.current) return;
    const doc = validateDocument(document);
    // A note with text opens with the caret at its end.
    const end = doc.textContent ? endSelection(doc) : null;
    const wide = window.matchMedia("(min-width: 761px)");
    const editor: EditorView = new EditorView(host.current, {
      state: EditorState.create({
        schema: notesSchema,
        doc,
        plugins: plugins(binding, {
          openLink: (target) => openLink.current(target),
          slashEnabled: () => wide.matches,
        }),
        ...(end ? { selection: end } : {}),
      }),
      editable: () => editable,
      nodeViews: { task_item: taskView },
      attributes: {
        "aria-label": "Note content",
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste: pasteMarkdown,
      transformPastedHTML: sanitizePastedHtml,
      transformPasted: safeSlice,
      clipboardTextSerializer: serializeClipboardText,
      handleDOMEvents: {
        click(target, event) {
          const anchor = linkElement(target, event);
          if (!anchor) return false;
          // The app never navigates away. A read-only note or a Cmd/Ctrl
          // click opens the link in a new tab.
          event.preventDefault();
          if (event.metaKey || event.ctrlKey || !target.editable) {
            const href = anchor.getAttribute("href");
            if (isSafeHref(href)) window.open(href, "_blank", "noopener");
            return true;
          }
          // In an editable note a tap places the caret and offers Open · Edit · Remove.
          const range = linkRangeAt(
            target.state.doc,
            target.posAtDOM(anchor, 0),
          );
          if (range)
            target.dispatch(
              target.state.tr.setMeta(linkUiKey, {
                mode: "menu",
                from: range.from,
                to: range.to,
              } satisfies LinkUi),
            );
          return true;
        },
        focus(target) {
          // Returning to the text closes an open link form.
          if (linkUiKey.getState(target.state)?.mode === "form")
            target.dispatch(target.state.tr.setMeta(linkUiKey, null));
          return false;
        },
        blur(target) {
          if (linkUiKey.getState(target.state)?.mode === "menu")
            target.dispatch(target.state.tr.setMeta(linkUiKey, null));
          return false;
        },
      },
      dispatchTransaction(transaction: Transaction) {
        editor.updateState(editor.state.apply(transaction));
        setToolbarState(editor.state);
        if (binding) binding.changed(editor, transaction);
        else if (transaction.docChanged)
          callback.current(
            JSON.stringify(editor.state.doc.toJSON()),
            editor.state.doc.textBetween(
              0,
              editor.state.doc.content.size,
              "\n",
            ),
          );
      },
    });
    view.current = editor;
    let detach: (() => void) | undefined;
    if (binding) {
      if (binding.pending.length) {
        // Replay unconfirmed recovery steps as local edits so they are sent again.
        const tr = editor.state.tr.setMeta("addToHistory", false);
        for (const json of binding.pending)
          tr.step(Step.fromJSON(notesSchema, JSON.parse(json)));
        editor.dispatch(tr);
      }
      detach = binding.attach(editor);
    }
    setToolbarState(editor.state);
    // Paste and copy use the Markdown code once it has loaded.
    void loadMarkdown().catch(() => undefined);
    return () => {
      detach?.();
      editor.destroy();
      view.current = null;
      setLinkForm(null);
    };
    // A new note or binding mounts a new editor. Readiness updates keep selection.
  }, [document, binding]);
  useEffect(() => {
    view.current?.setProps({ editable: () => editable });
    if (view.current) setToolbarState(view.current.state);
  }, [editable]);
  useEffect(() => {
    // Tapping the blank area below the text puts the caret at the end.
    const editor = view.current;
    const box = surface.current;
    const region = box?.closest<HTMLElement>(".note-content-region") ?? box;
    if (!editor || !region || !editable) return;
    const below = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || editor.dom.contains(target))
        return false;
      if (
        target.closest(
          "button, a, input, textarea, select, label, form, [role='toolbar'], [role='listbox'], .note-toolbar",
        )
      )
        return false;
      return event.clientY > editor.dom.getBoundingClientRect().bottom;
    };
    const press = (event: MouseEvent) => {
      if (below(event)) event.preventDefault();
    };
    const tap = (event: MouseEvent) => {
      if (!below(event) || !editor.editable) return;
      selectEnd(editor.state, editor.dispatch);
      editor.focus();
    };
    region.addEventListener("mousedown", press);
    region.addEventListener("click", tap);
    return () => {
      region.removeEventListener("mousedown", press);
      region.removeEventListener("click", tap);
    };
  }, [document, binding, editable]);
  useEffect(() => {
    // The iOS keyboard covers the bottom of the layout viewport, where the
    // phone formatting bar is fixed; publish how much it covers so the bar
    // can sit on top of it.
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = window.document.documentElement;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const covered =
          viewport.scale > 1.01
            ? 0
            : window.innerHeight - viewport.height - viewport.offsetTop;
        root.style.setProperty(
          "--keyboard-inset",
          `${Math.max(0, Math.round(covered))}px`,
        );
      });
    };
    place();
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
  const runTool = (tool: Tool) => {
    const editor = view.current;
    if (!editable || !editor || !tool.command(editor.state)) return;
    if (tool.opensLinkForm) {
      openLinkForm(editor);
      return;
    }
    tool.command(editor.state, editor.dispatch, editor);
    editor.focus();
  };
  const renderTool = (tool: Tool) => {
    const enabled =
      editable && toolbarState !== null && tool.command(toolbarState);
    const active = toolbarState !== null && !!tool.active?.(toolbarState);
    return (
      <button
        key={tool.label}
        type="button"
        className={`editor-tool ${active ? "is-active" : ""}`}
        aria-label={tool.label}
        title={tool.label}
        aria-pressed={tool.active ? active : undefined}
        disabled={!enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => runTool(tool)}
      >
        <span aria-hidden={!!tool.glyph}>{tool.glyph ?? tool.label}</span>
      </button>
    );
  };
  /** Popover position under document position `pos`, inside `.editor-host`. */
  const anchorAt = (pos: number): CSSProperties | undefined => {
    const editor = view.current;
    const box = surface.current;
    if (!editor || !box) return undefined;
    try {
      const coords = editor.coordsAtPos(pos);
      const bounds = box.getBoundingClientRect();
      return {
        "--anchor-top": `${Math.round(coords.bottom - bounds.top + 6)}px`,
        "--anchor-left": `${Math.round(Math.max(0, coords.left - bounds.left))}px`,
      } as CSSProperties;
    } catch {
      return undefined;
    }
  };
  const closeLinkUi = (editor: EditorView) =>
    editor.dispatch(editor.state.tr.setMeta(linkUiKey, null));
  const linkState = toolbarState ? linkUiKey.getState(toolbarState) : null;
  const menu =
    editable && toolbarState && linkState?.mode === "menu"
      ? linkRangeAt(toolbarState.doc, linkState.from)
      : null;
  const formTarget = linkForm && linkState?.mode === "form" ? linkState : null;
  const applyLinkForm = () => {
    const editor = view.current;
    const target = editor && linkUiKey.getState(editor.state);
    if (!editor || !linkForm || target?.mode !== "form") return;
    const href = normalizeHref(linkForm.href);
    if (!href) {
      setLinkForm({
        ...linkForm,
        error: "Enter a web address, such as example.com, or an email address.",
      });
      return;
    }
    if (editor.editable && !linkable(editor.state, target.from, target.to)) {
      // A collaborator moved the text into code or across lines: leave it.
      setLinkForm(null);
      closeLinkUi(editor);
      setLinkNotice("The text can no longer be linked.");
      editor.focus();
      return;
    }
    const text = linkForm.text.trim() ? linkForm.text : linkForm.href.trim();
    const tr = editor.editable
      ? applyLink(editor.state, target.from, target.to, text, href, {
          textEdited: linkForm.textEdited,
          touched: !!target.touched,
          original: target.content,
        })
      : editor.state.tr;
    if (!tr) {
      // Someone changed the text while the form was open: show it as it is
      // now, rather than overwrite their edit.
      editor.dispatch(
        editor.state.tr.setMeta(linkUiKey, {
          ...target,
          touched: false,
          content: editor.state.doc.slice(target.from, target.to).content,
        } satisfies LinkUi),
      );
      setLinkForm({
        ...linkForm,
        text: editor.state.doc.textBetween(target.from, target.to),
        textEdited: false,
        error:
          "This text changed while the form was open. Check it and apply again.",
      });
      return;
    }
    editor.dispatch(tr.setMeta(linkUiKey, null));
    setLinkForm(null);
    editor.focus();
  };
  useEffect(() => {
    if (!linkNotice) return;
    const timer = window.setTimeout(() => setLinkNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [linkNotice]);
  const cancelLinkForm = () => {
    const editor = view.current;
    setLinkForm(null);
    if (!editor) return;
    closeLinkUi(editor);
    editor.focus();
  };
  const slash = toolbarState ? slashKey.getState(toolbarState) : null;
  const choices = slash && toolbarState ? slashChoices(toolbarState) : [];
  return (
    <>
      <div
        className="formatting-toolbar"
        role="toolbar"
        aria-label="Note formatting"
      >
        {(Object.keys(toolGroups) as ToolGroup[]).map((group) => (
          <div
            className="editor-tool-group"
            key={group}
            role="group"
            aria-label={group}
          >
            {toolGroups[group].map(renderTool)}
          </div>
        ))}
        <div className="editor-history" role="group" aria-label="Edit history">
          {historyTools.map(renderTool)}
        </div>
      </div>
      <div className="editor-host" ref={surface}>
        {editedLabel && <p className="edited-date">{editedLabel}</p>}
        <div ref={host} />
        {menu && (
          <div
            className="link-menu"
            role="toolbar"
            aria-label="Link"
            style={anchorAt(menu.from)}
          >
            <span className="link-menu-address">{menu.href}</span>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (isSafeHref(menu.href))
                  window.open(menu.href, "_blank", "noopener");
                if (view.current) closeLinkUi(view.current);
              }}
            >
              Open
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => view.current && openLinkForm(view.current)}
            >
              Edit
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const editor = view.current;
                if (!editor) return;
                editor.dispatch(
                  removeLink(editor.state, menu.from, menu.to).setMeta(
                    linkUiKey,
                    null,
                  ),
                );
                editor.focus();
              }}
            >
              Remove
            </button>
          </div>
        )}
        {linkNotice && (
          <p className="link-notice" role="status">
            {linkNotice}
          </p>
        )}
        {formTarget && linkForm && (
          <form
            className="link-form"
            aria-label="Link"
            noValidate
            style={anchorAt(formTarget.from)}
            onSubmit={(event) => {
              event.preventDefault();
              applyLinkForm();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              cancelLinkForm();
            }}
          >
            <input
              ref={linkText}
              className="link-input"
              type="text"
              aria-label="Link text"
              placeholder="Text"
              value={linkForm.text}
              onChange={(event) =>
                setLinkForm({
                  ...linkForm,
                  text: event.target.value,
                  textEdited: true,
                })
              }
            />
            <input
              ref={linkHref}
              className="link-input"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Link address"
              placeholder="example.com"
              value={linkForm.href}
              onChange={(event) =>
                setLinkForm({
                  ...linkForm,
                  href: event.target.value,
                  error: "",
                })
              }
            />
            <div className="link-form-actions">
              <button type="submit" disabled={!linkForm.href.trim()}>
                Apply
              </button>
              <button type="button" onClick={cancelLinkForm}>
                Cancel
              </button>
            </div>
            {linkForm.error && (
              <p className="link-error" role="alert">
                {linkForm.error}
              </p>
            )}
          </form>
        )}
        {slash && choices.length > 0 && (
          <div
            className="slash-palette"
            role="listbox"
            aria-label="Insert"
            style={anchorAt(slash.from)}
          >
            {choices.map((action, index) => (
              <button
                key={action.label}
                type="button"
                role="option"
                aria-selected={
                  index === Math.min(slash.index, choices.length - 1)
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  view.current && runSlash(view.current, action, openLinkForm)
                }
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className="mobile-editor-tools"
        role="toolbar"
        aria-label="Mobile note formatting"
      >
        {mobileGroup && (
          <div
            className="mobile-tool-subrow"
            role="group"
            aria-label={mobileGroup}
          >
            {toolGroups[mobileGroup].map(renderTool)}
          </div>
        )}
        <div className="mobile-tool-groups">
          {(Object.keys(toolGroups) as ToolGroup[]).map((group) => (
            <button
              key={group}
              type="button"
              className={`editor-tool-group-toggle ${mobileGroup === group ? "is-active" : ""}`}
              aria-label={`${group} tools`}
              aria-expanded={mobileGroup === group}
              disabled={!editable}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                setMobileGroup((current) => (current === group ? null : group))
              }
            >
              {group === "Style" ? (
                "Aa"
              ) : group === "Format" ? (
                boldGlyph
              ) : (
                <EditorGlyph name="bullet-list" />
              )}
              <span className="mobile-tool-label">{group}</span>
            </button>
          ))}
          <div
            className="editor-history"
            role="group"
            aria-label="Edit history"
          >
            {historyTools.map(renderTool)}
          </div>
        </div>
      </div>
    </>
  );
}
