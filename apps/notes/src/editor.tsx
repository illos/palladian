import { useEffect, useRef } from "react";
import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
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
export function emptyDocument() {
  return JSON.stringify(notesSchema.topNodeType.createAndFill()?.toJSON());
}
export function textDocument(lines: string[]) {
  return JSON.stringify(
    notesSchema
      .node(
        "doc",
        null,
        lines.map((line) =>
          notesSchema.node(
            "paragraph",
            null,
            line ? notesSchema.text(line) : undefined,
          ),
        ),
      )
      .toJSON(),
  );
}
export function NoteEditor({
  document,
  editable,
  onChange,
}: {
  document: string;
  editable: boolean;
  onChange: (document: string, text: string) => void;
}) {
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
    return () => {
      editor.destroy();
      view.current = null;
    };
    // A new note mounts a new editor. Readiness updates without recreating selection.
  }, [document]);
  useEffect(() => {
    view.current?.setProps({ editable: () => editable });
  }, [editable]);
  return <div ref={host} className="editor-host" />;
}
