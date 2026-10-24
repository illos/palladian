import { attachmentObjectId, isObjectId } from "@palladian/notes-core/schema";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { fileWritesEnabled } from "./file-capability";

/**
 * The file-note view in the editor (plan 08 B4, D103). When a note is a
 * title line, one uploaded file and optional text (file-notes.ts has the
 * same rule for stored documents), the file block shows large: an image
 * fitted to the width, a PDF in the reader, any other file as a large icon
 * with Download. The rest of the note stays ordinary, editable text.
 *
 * A node decoration marks that block; its node view reads the mark
 * (attachment-views.ts). The document is never changed for it, and while
 * files are off there is no mark, so the note renders as before B3.
 */

const fileNoteKey = new PluginKey<DecorationSet>("file-note");

/** The spec the mark carries; node views check it. */
const FILE_NOTE = { fileNote: true } as const;

/** Whether a block is an uploaded file: a file block or an attachment image. */
function uploaded(node: ProseMirrorNode) {
  if (node.type.name === "file") return isObjectId(node.attrs.objectId);
  if (node.type.name === "image")
    return attachmentObjectId(node.attrs.src) !== null;
  return false;
}

/**
 * Where the file of a file note is: the second block, if the first is a
 * text line, the second an uploaded file, and nothing else in the note is an
 * image or file. Null for any other note. Cheap for ordinary notes: most
 * fail at the second block, before the walk.
 */
export function fileNoteBlock(
  doc: ProseMirrorNode,
): { pos: number; node: ProseMirrorNode } | null {
  if (doc.childCount < 2) return null;
  const title = doc.child(0);
  const file = doc.child(1);
  if (!title.isTextblock || !uploaded(file)) return null;
  let media = 0;
  doc.descendants((node) => {
    if (media > 1) return false;
    if (node.type.name === "image" || node.type.name === "file") media++;
    return !node.isTextblock;
  });
  return media === 1 ? { pos: title.nodeSize, node: file } : null;
}

function marks(doc: ProseMirrorNode) {
  const block = fileNoteBlock(doc);
  return block
    ? DecorationSet.create(doc, [
        Decoration.node(
          block.pos,
          block.pos + block.node.nodeSize,
          {},
          FILE_NOTE,
        ),
      ])
    : DecorationSet.empty;
}

/** Marks a file note's file while files are on. */
export function fileNotePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: fileNoteKey,
    state: {
      init: (_config, state) => marks(state.doc),
      apply: (tr, value) => (tr.docChanged ? marks(tr.doc) : value),
    },
    props: {
      decorations: (state) =>
        fileWritesEnabled() ? (fileNoteKey.getState(state) ?? null) : null,
    },
  });
}

/** Whether a node view's decorations mark it as a file note's file. */
export function isFileNoteFile(decorations: readonly Decoration[]) {
  return decorations.some(
    (decoration) =>
      (decoration.spec as { fileNote?: unknown }).fileNote === true,
  );
}
