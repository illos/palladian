import { useEffect, useRef, useState, type ReactNode } from "react";
import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import {
  addListNodes,
  liftListItem,
  wrapInList,
} from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  baseKeymap,
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { inputRules, textblockTypeInputRule } from "prosemirror-inputrules";

export const notesSchema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block"),
  marks: basicSchema.spec.marks,
});
export function validateDocument(document: string) {
  const node = notesSchema.nodeFromJSON(JSON.parse(document));
  node.check();
  if (node.type !== notesSchema.topNodeType)
    throw new Error("Invalid note document.");
  return node;
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
  name: "undo" | "redo" | "code" | "bullet-list" | "numbered-list" | "quote";
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
  return {
    label,
    glyph,
    command: (state, dispatch, view) =>
      inNode(state, type)
        ? liftListItem(notesSchema.nodes.list_item!)(state, dispatch, view)
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

export function NoteEditor({
  document,
  editable,
  onChange,
}: {
  document: string;
  editable: boolean;
  onChange: (document: string, text: string) => void;
}) {
  const [toolbarState, setToolbarState] = useState<EditorState | null>(null);
  const [mobileGroup, setMobileGroup] = useState<ToolGroup | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView(host.current, {
      state: EditorState.create({
        schema: notesSchema,
        doc: validateDocument(document),
        plugins: [
          history(),
          inputRules({
            rules: [
              textblockTypeInputRule(
                /^(#{1,3})\s$/,
                notesSchema.nodes.heading!,
                (match) => ({ level: match[1]!.length }),
              ),
            ],
          }),
          keymap({
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Mod-b": toggleMark(notesSchema.marks.strong!),
            "Mod-i": toggleMark(notesSchema.marks.em!),
            Tab: (state, dispatch) => {
              const { $from } = state.selection;
              const text = $from.parent.textContent;
              const match = /^(#{1,3})(.+)$/.exec(text);
              if (
                !match ||
                $from.parent.type.name !== "paragraph" ||
                $from.parentOffset !== text.length
              )
                return false;
              if (dispatch) {
                const tr = state.tr.delete(
                  $from.start(),
                  $from.start() + match[1]!.length,
                );
                tr.setBlockType(
                  $from.before(),
                  $from.before() + tr.doc.nodeAt($from.before())!.nodeSize,
                  notesSchema.nodes.heading!,
                  { level: match[1]!.length },
                );
                dispatch(tr);
              }
              return true;
            },
            "Mod-Alt-0": setBlockType(notesSchema.nodes.paragraph!),
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => editable,
      attributes: {
        "aria-label": "Note content",
        role: "textbox",
        "aria-multiline": "true",
      },
      dispatchTransaction(transaction) {
        editor.updateState(editor.state.apply(transaction));
        setToolbarState(editor.state);
        if (transaction.docChanged)
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
    setToolbarState(editor.state);
    return () => {
      editor.destroy();
      view.current = null;
    };
    // A new note mounts a new editor. Readiness updates without recreating selection.
  }, [document]);
  useEffect(() => {
    view.current?.setProps({ editable: () => editable });
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
      <div ref={host} className="editor-host" />
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
