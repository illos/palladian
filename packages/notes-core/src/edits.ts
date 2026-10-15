import {
  Fragment,
  type Node as ProseMirrorNode,
  type NodeType,
} from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { assignBlockIds } from "./ids.ts";
import { blockToMarkdown, parseMarkdownFragment } from "./markdown.ts";
import { assertSafeDocument, hasBlockId, notesSchema } from "./schema.ts";

/** Bounded agent edit operations. Every batch applies atomically or not at all. */
export type NoteEdit =
  | { type: "replace_text"; old_text: string; new_text: string }
  | { type: "append"; markdown: string }
  | { type: "insert_after"; block_id: string; markdown: string }
  | { type: "insert_before"; block_id: string; markdown: string }
  | {
      type: "replace_block";
      block_id: string;
      markdown: string;
      block_hash?: string;
    }
  | { type: "delete_block"; block_id: string; block_hash?: string }
  | { type: "set_checked"; block_id: string; checked: boolean }
  | { type: "replace_all"; markdown: string };

export type EditErrorCode = "not_found" | "ambiguous" | "conflict" | "invalid";
export class EditError extends Error {
  readonly code: EditErrorCode;
  readonly editIndex: number;
  constructor(code: EditErrorCode, message: string, editIndex: number) {
    super(message);
    this.code = code;
    this.editIndex = editIndex;
  }
}

export const MAX_EDITS = 50;

/** FNV-1a over the block's JSON; a cheap precondition, not a security check. */
export function blockHash(node: ProseMirrorNode): string {
  const text = JSON.stringify(node.toJSON());
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface OutlineEntry {
  id: string;
  type: string;
  depth: number;
  parentId: string | null;
  hash: string;
  markdown: string;
  checked?: boolean;
}

/** Top-level blocks plus list/task items, for block-targeted agent edits. */
export function outline(doc: ProseMirrorNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  doc.forEach((block) => {
    const id = String(block.attrs.id ?? "");
    entries.push({
      id,
      type: block.type.name,
      depth: 0,
      parentId: null,
      hash: blockHash(block),
      markdown: blockToMarkdown(block),
    });
    if (isList(block.type))
      block.forEach((item) => {
        entries.push({
          id: String(item.attrs.id ?? ""),
          type: item.type.name,
          depth: 1,
          parentId: id,
          hash: blockHash(item),
          markdown: blockToMarkdown(
            block.type.create(block.attrs, Fragment.from(item)),
          ),
          ...(item.type.name === "task_item"
            ? { checked: !!item.attrs.checked }
            : {}),
        });
      });
  });
  return entries;
}

const {
  bullet_list,
  ordered_list,
  task_list,
  list_item,
  task_item,
  paragraph,
} = notesSchema.nodes as Record<string, NodeType>;

function isList(type: NodeType) {
  return type === bullet_list || type === ordered_list || type === task_list;
}
function isItem(type: NodeType) {
  return type === list_item || type === task_item;
}

/** Keep IDs of structurally matching blocks so small edits stay targetable. */
function reuseIds(
  previous: readonly ProseMirrorNode[],
  next: Fragment,
): Fragment {
  const nodes: ProseMirrorNode[] = [];
  next.forEach((node, _offset, index) => {
    const old = previous[index];
    if (!old || old.type !== node.type || !hasBlockId(node)) {
      nodes.push(node);
      return;
    }
    const children: ProseMirrorNode[] = [];
    old.forEach((child) => children.push(child));
    const content = node.isTextblock
      ? node.content
      : reuseIds(children, node.content);
    nodes.push(
      node.type.create(
        { ...node.attrs, id: old.attrs.id },
        content,
        node.marks,
      ),
    );
  });
  return Fragment.from(nodes);
}

function children(fragment: Fragment) {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => nodes.push(node));
  return nodes;
}

function findBlock(doc: ProseMirrorNode, id: string) {
  let found: {
    node: ProseMirrorNode;
    pos: number;
    parent: ProseMirrorNode;
  } | null = null;
  doc.descendants((node, pos, parent) => {
    if (found) return false;
    if (hasBlockId(node) && node.attrs.id === id && parent) {
      found = { node, pos, parent };
      return false;
    }
    return !node.isTextblock;
  });
  return found as {
    node: ProseMirrorNode;
    pos: number;
    parent: ProseMirrorNode;
  } | null;
}

/** Convert parsed Markdown into items of the target list's item type. */
function asItems(fragment: Fragment, itemType: NodeType): Fragment {
  const blocks = children(fragment);
  const only = blocks.length === 1 ? blocks[0] : undefined;
  const items =
    only && isList(only.type)
      ? children(only.content)
      : [list_item!.createAndFill(null, fragment)];
  return Fragment.from(
    items.map((item) => {
      if (!item) throw new Error("Invalid list item content.");
      if (item.type === itemType) return item;
      const attrs =
        itemType === task_item
          ? { id: item.attrs.id, checked: false }
          : { id: item.attrs.id };
      const converted = itemType.createAndFill(attrs, item.content);
      if (!converted) throw new Error("Invalid list item content.");
      return converted;
    }),
  );
}

function contentFor(markdown: string, parent: ProseMirrorNode): Fragment {
  const fragment = parseMarkdownFragment(markdown);
  if (!isList(parent.type)) return fragment;
  return asItems(fragment, parent.type === task_list ? task_item! : list_item!);
}

interface Segment {
  start: number;
  end: number;
}
function topLevelMarkdown(doc: ProseMirrorNode) {
  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  doc.forEach((node, _offset, index) => {
    if (index > 0) cursor += 2;
    const md = blockToMarkdown(node);
    parts.push(md);
    segments.push({ start: cursor, end: cursor + md.length });
    cursor += md.length;
  });
  return { text: parts.join("\n\n"), segments };
}

function replaceText(
  tr: Transform,
  oldText: string,
  newText: string,
  at: number,
) {
  if (!oldText)
    throw new EditError("invalid", "old_text must not be empty.", at);
  const { text, segments } = topLevelMarkdown(tr.doc);
  const first = text.indexOf(oldText);
  if (first < 0)
    throw new EditError(
      "not_found",
      "old_text was not found. Read the note again and copy the text exactly as it appears in its Markdown.",
      at,
    );
  if (text.indexOf(oldText, first + 1) >= 0)
    throw new EditError(
      "ambiguous",
      "old_text appears more than once. Include more surrounding text so it matches exactly one place.",
      at,
    );
  const last = first + oldText.length;
  // Blocks touched by the match. A matched separator touches both neighbours,
  // so replacing it merges or splits them as the new text says.
  let i = 0;
  while (i + 1 < segments.length && segments[i + 1]!.start <= first) i++;
  let j = i;
  while (j + 1 < segments.length && segments[j + 1]!.start <= last) j++;
  const segStart = Math.min(first, segments[i]!.start);
  const segEnd = Math.max(last, segments[j]!.end);
  const replaced =
    text.slice(segStart, first) + newText + text.slice(last, segEnd);
  const from = blockPos(tr.doc, i);
  const to = blockPos(tr.doc, j) + tr.doc.child(j).nodeSize;
  const previous: ProseMirrorNode[] = [];
  for (let k = i; k <= j; k++) previous.push(tr.doc.child(k));
  const fragment = reuseIds(previous, parseMarkdownFragment(replaced));
  replaceRange(tr, from, to, fragment);
}

function blockPos(doc: ProseMirrorNode, index: number) {
  let pos = 0;
  for (let k = 0; k < index; k++) pos += doc.child(k).nodeSize;
  return pos;
}

/** Replace top-level content, keeping the document non-empty. */
function replaceRange(
  tr: Transform,
  from: number,
  to: number,
  fragment: Fragment,
) {
  const whole = from === 0 && to === tr.doc.content.size;
  if (fragment.childCount === 0 && whole) {
    tr.replaceWith(from, to, paragraph!.create());
    return;
  }
  if (fragment.childCount === 0) tr.delete(from, to);
  else tr.replaceWith(from, to, fragment);
}

function isEmptyDoc(doc: ProseMirrorNode) {
  return (
    doc.childCount === 1 &&
    doc.firstChild!.type === paragraph &&
    doc.firstChild!.content.size === 0
  );
}

function applyOne(tr: Transform, edit: NoteEdit, at: number) {
  switch (edit.type) {
    case "replace_text":
      replaceText(tr, edit.old_text, edit.new_text, at);
      return;
    case "append": {
      const fragment = parseMarkdownFragment(edit.markdown);
      if (!fragment.childCount) return;
      if (isEmptyDoc(tr.doc)) tr.replaceWith(0, tr.doc.content.size, fragment);
      else tr.insert(tr.doc.content.size, fragment);
      return;
    }
    case "replace_all": {
      const previous = children(tr.doc.content);
      const fragment = reuseIds(previous, parseMarkdownFragment(edit.markdown));
      replaceRange(tr, 0, tr.doc.content.size, fragment);
      return;
    }
  }
  const found = findBlock(tr.doc, edit.block_id);
  if (!found)
    throw new EditError(
      "not_found",
      `Block ${edit.block_id} does not exist in the current revision.`,
      at,
    );
  const { node, pos, parent } = found;
  if (
    (edit.type === "replace_block" || edit.type === "delete_block") &&
    edit.block_hash !== undefined &&
    edit.block_hash !== blockHash(node)
  )
    throw new EditError(
      "conflict",
      `Block ${edit.block_id} changed since it was read. Read the note again.`,
      at,
    );
  switch (edit.type) {
    case "set_checked":
      if (node.type !== task_item)
        throw new EditError(
          "invalid",
          "Only checklist items can be checked.",
          at,
        );
      tr.setNodeAttribute(pos, "checked", edit.checked);
      return;
    case "delete_block": {
      if (parent.childCount === 1 && isItem(node.type)) {
        // Deleting a list's last item removes the list.
        const listPos = tr.doc.resolve(pos).before();
        const list = tr.doc.nodeAt(listPos)!;
        deleteNode(tr, listPos, list);
        return;
      }
      deleteNode(tr, pos, node);
      return;
    }
    case "insert_after":
    case "insert_before": {
      const fragment = contentFor(edit.markdown, parent);
      if (!fragment.childCount) return;
      tr.insert(
        edit.type === "insert_after" ? pos + node.nodeSize : pos,
        fragment,
      );
      return;
    }
    case "replace_block": {
      const fragment = reuseIds([node], contentFor(edit.markdown, parent));
      if (!fragment.childCount) {
        deleteNode(tr, pos, node);
        return;
      }
      tr.replaceWith(pos, pos + node.nodeSize, fragment);
      return;
    }
  }
}

function deleteNode(tr: Transform, pos: number, node: ProseMirrorNode) {
  const $pos = tr.doc.resolve(pos);
  if ($pos.depth === 0 && tr.doc.childCount === 1)
    tr.replaceWith(pos, pos + node.nodeSize, paragraph!.create());
  else tr.delete(pos, pos + node.nodeSize);
}

/**
 * Apply agent edits to the current document. The returned transform's steps
 * are what the server appends to the note's step log.
 */
export function applyEdits(doc: ProseMirrorNode, edits: NoteEdit[]): Transform {
  if (!edits.length) throw new EditError("invalid", "No edits supplied.", 0);
  if (edits.length > MAX_EDITS)
    throw new EditError("invalid", `At most ${MAX_EDITS} edits per call.`, 0);
  const tr = new Transform(doc);
  edits.forEach((edit, index) => {
    try {
      applyOne(tr, edit, index);
    } catch (error) {
      if (error instanceof EditError) throw error;
      throw new EditError(
        "invalid",
        error instanceof Error ? error.message : "Edit could not be applied.",
        index,
      );
    }
  });
  assignBlockIds(tr);
  tr.doc.check();
  assertSafeDocument(tr.doc);
  return tr;
}
