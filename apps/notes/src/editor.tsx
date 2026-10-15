import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  blockIdPlugin,
  notesSchema,
  parseStoredDoc,
} from "@palladian/notes-core";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
  wrapInList,
} from "prosemirror-schema-list";
import {
  EditorState,
  type Command,
  type Plugin,
  type Transaction,
} from "prosemirror-state";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import {
  baseKeymap,
  chainCommands,
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { collab } from "prosemirror-collab";
import { Step } from "prosemirror-transform";
import type { MarkType } from "prosemirror-model";
import type { EditorBinding } from "./binding";

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
    | "checklist";
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
        name === "undo" || name === "redo" || name === "code" ? 1.7 : 1.6
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

function inNode(state: EditorState, name: string) {
  for (let depth = state.selection.$from.depth; depth > 0; depth--) {
    if (state.selection.$from.node(depth).type.name === name) return true;
  }
  return false;
}
function markActive(state: EditorState, name: string) {
  const mark = notesSchema.marks[name]!;
  return state.selection.empty
    ? !!mark.isInSet(state.storedMarks ?? state.selection.$from.marks())
    : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark);
}
function blockStyle(label: string, type: string, level?: number): Tool {
  return {
    label,
    command: setBlockType(
      notesSchema.nodes[type]!,
      level ? { level } : undefined,
    ),
    active: (state) =>
      state.selection.$from.parent.type.name === type &&
      (!level || state.selection.$from.parent.attrs.level === level),
  };
}
function listTool(label: string, type: string, glyph: ReactNode): Tool {
  const item =
    type === "task_list"
      ? notesSchema.nodes.task_item!
      : notesSchema.nodes.list_item!;
  return {
    label,
    glyph,
    command: (state, dispatch, view) =>
      inNode(state, type)
        ? liftListItem(item)(state, dispatch, view)
        : wrapInList(notesSchema.nodes[type]!)(state, dispatch, view),
    active: (state) => inNode(state, type),
  };
}
const toolGroups: Record<ToolGroup, Tool[]> = {
  Style: [
    blockStyle("Title", "heading", 1),
    blockStyle("Heading", "heading", 2),
    blockStyle("Subhead", "heading", 3),
    blockStyle("Body", "paragraph"),
    blockStyle("Mono", "code_block"),
  ],
  Format: [
    {
      label: "Bold",
      glyph: boldGlyph,
      command: toggleMark(notesSchema.marks.strong!),
      active: (state) => markActive(state, "strong"),
    },
    {
      label: "Italic",
      glyph: italicGlyph,
      command: toggleMark(notesSchema.marks.em!),
      active: (state) => markActive(state, "em"),
    },
    {
      label: "Strikethrough",
      glyph: strikeGlyph,
      command: toggleMark(notesSchema.marks.strike!),
      active: (state) => markActive(state, "strike"),
    },
    {
      label: "Inline code",
      glyph: <EditorGlyph name="code" />,
      command: toggleMark(notesSchema.marks.code!),
      active: (state) => markActive(state, "code"),
    },
  ],
  Lists: [
    listTool(
      "Bulleted list",
      "bullet_list",
      <EditorGlyph name="bullet-list" />,
    ),
    listTool(
      "Numbered list",
      "ordered_list",
      <EditorGlyph name="numbered-list" />,
    ),
    listTool("Checklist", "task_list", <EditorGlyph name="checklist" />),
    {
      label: "Quote",
      glyph: <EditorGlyph name="quote" />,
      command: (state, dispatch, view) =>
        inNode(state, "blockquote")
          ? lift(state, dispatch, view)
          : wrapIn(notesSchema.nodes.blockquote!)(state, dispatch, view),
      active: (state) => inNode(state, "blockquote"),
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
} = notesSchema.nodes as Record<string, import("prosemirror-model").NodeType>;
const marks = notesSchema.marks as Record<string, MarkType>;

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

function plugins(binding: EditorBinding | undefined): Plugin[] {
  const list = [
    ...(binding
      ? [collab({ version: binding.version, clientID: binding.clientId })]
      : []),
    blockIdPlugin((tr) => tr.getMeta("rebased") !== undefined),
    history(),
    inputRules({
      rules: [
        textblockTypeInputRule(/^(#{1,3})\s$/, heading!, (match) => ({
          level: match[1]!.length,
        })),
        wrappingInputRule(/^\s*([-+*])\s$/, bullet_list!),
        wrappingInputRule(
          /^(\d+)\.\s$/,
          ordered_list!,
          (match) => ({ order: Number(match[1]) }),
          (match, node) =>
            node.childCount + Number(node.attrs.order) === Number(match[1]),
        ),
        wrappingInputRule(/^\[( |x)?\]\s$/, task_list!),
        wrappingInputRule(/^\s*>\s$/, blockquote!),
        markRule(/\*\*([^*]+)\*\*$/, marks.strong!),
        markRule(/(?:^|[^*])\*([^*]+)\*$/, marks.em!),
        markRule(/~~([^~]+)~~$/, marks.strike!),
        markRule(/`([^`]+)`$/, marks.code!),
      ],
    }),
    keymap({
      "Mod-z": undo,
      "Mod-Shift-z": redo,
      "Mod-y": redo,
      "Mod-b": toggleMark(marks.strong!),
      "Mod-i": toggleMark(marks.em!),
      "Mod-Shift-x": toggleMark(marks.strike!),
      "Mod-e": toggleMark(marks.code!),
      Enter: chainCommands(
        fenceToCode,
        splitListItem(task_item!),
        splitListItem(list_item!),
      ),
      Tab: chainCommands(
        hashHeading,
        sinkListItem(list_item!),
        sinkListItem(task_item!),
      ),
      "Shift-Tab": chainCommands(
        liftListItem(list_item!),
        liftListItem(task_item!),
      ),
      "Mod-Alt-0": setBlockType(paragraph!),
    }),
    keymap(baseKeymap),
  ];
  return list;
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
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const editor: EditorView = new EditorView(host.current, {
      state: EditorState.create({
        schema: notesSchema,
        doc: validateDocument(document),
        plugins: plugins(binding),
      }),
      editable: () => editable,
      nodeViews: { task_item: taskView },
      attributes: {
        "aria-label": "Note content",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const link = (event.target as HTMLElement | null)?.closest("a[href]");
        if (link && (event.metaKey || event.ctrlKey || !editor.editable)) {
          window.open(link.getAttribute("href")!, "_blank", "noopener");
          return true;
        }
        return false;
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
    return () => {
      detach?.();
      editor.destroy();
      view.current = null;
    };
    // A new note or binding mounts a new editor. Readiness updates keep selection.
  }, [document, binding]);
  useEffect(() => {
    view.current?.setProps({ editable: () => editable });
    if (view.current) setToolbarState(view.current.state);
  }, [editable]);
  const runTool = (tool: Tool) => {
    const editor = view.current;
    if (!editable || !editor || !tool.command(editor.state)) return;
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
      <div className="editor-host">
        {editedLabel && <p className="edited-date">{editedLabel}</p>}
        <div ref={host} />
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
