import { notesSchema } from "@palladian/notes-core/schema";
import {
  Fragment,
  type Attrs,
  type Node as ProseMirrorNode,
  type NodeType,
} from "prosemirror-model";
import {
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { canJoin } from "prosemirror-transform";
import {
  chainCommands,
  lift,
  newlineInCode,
  wrapIn,
} from "prosemirror-commands";

const nodes = notesSchema.nodes;
const paragraph = nodes.paragraph!;
const blockquote = nodes.blockquote!;
const horizontalRule = nodes.horizontal_rule!;
const hardBreak = nodes.hard_break!;
const bulletList = nodes.bullet_list!;
const orderedList = nodes.ordered_list!;
const taskList = nodes.task_list!;
const listItem = nodes.list_item!;
const taskItem = nodes.task_item!;

function hasAttrs(node: ProseMirrorNode, type: NodeType, attrs: Attrs) {
  return (
    node.type === type &&
    Object.entries(attrs).every(([key, value]) => node.attrs[key] === value)
  );
}

/** Set every textblock in the selection to `type`, keeping each block's ID. */
export function setBlock(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let applicable = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (applicable) return false;
      if (!node.isTextblock) return true;
      if (!hasAttrs(node, type, attrs)) {
        const $pos = state.doc.resolve(pos);
        applicable =
          node.type === type ||
          $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type);
      }
      return false;
    });
    if (!applicable) return false;
    if (dispatch)
      dispatch(
        state.tr
          .setBlockType(
            from,
            to,
            type,
            (old) =>
              type.create({
                ...(old.type === type ? old.attrs : {}),
                ...attrs,
                id: old.attrs.id,
              }).attrs,
          )
          .scrollIntoView(),
      );
    return true;
  };
}

/** A style button: applies the style, or returns an already styled block to body text. */
export function toggleBlock(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch, view) =>
    (hasAttrs(state.selection.$from.parent, type, attrs)
      ? setBlock(paragraph)
      : setBlock(type, attrs))(state, dispatch, view);
}

export function blockActive(
  state: EditorState,
  type: NodeType,
  attrs: Attrs = {},
) {
  return hasAttrs(state.selection.$from.parent, type, attrs);
}

function inside(state: EditorState, type: NodeType) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--)
    if ($from.node(depth).type === type) return true;
  return false;
}

/** Quote button and Mod-Shift-.: wrap in a quote, or lift out of one. */
export const toggleQuote: Command = (state, dispatch, view) =>
  inside(state, blockquote)
    ? lift(state, dispatch, view)
    : wrapIn(blockquote)(state, dispatch, view);

export function quoteActive(state: EditorState) {
  return inside(state, blockquote);
}

export type ListKind = "bullet" | "ordered" | "checklist";
const listTypes: Record<ListKind, NodeType> = {
  bullet: bulletList,
  ordered: orderedList,
  checklist: taskList,
};
function kindOf(type: NodeType): ListKind | null {
  return type === bulletList
    ? "bullet"
    : type === orderedList
      ? "ordered"
      : type === taskList
        ? "checklist"
        : null;
}
function itemFor(list: NodeType) {
  return list === taskList ? taskItem : listItem;
}
function convertItem(item: ProseMirrorNode, type: NodeType) {
  if (item.type === type) return item;
  return type.create(
    type === taskItem
      ? { id: item.attrs.id, checked: false }
      : { id: item.attrs.id },
    item.content,
  );
}

/** The kind of the innermost list around the caret, for the toolbar. */
export function currentListKind(state: EditorState): ListKind | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const kind = kindOf($from.node(depth).type);
    if (kind) return kind;
  }
  return null;
}

/** Depth of the innermost list that contains both ends of the selection, or -1. */
function sharedListDepth(state: EditorState) {
  const { $from, $to } = state.selection;
  for (let depth = Math.min($from.depth, $to.depth); depth > 0; depth--)
    if (
      kindOf($from.node(depth).type) &&
      $from.before(depth) === $to.before(depth)
    )
      return depth;
  return -1;
}

/** Where a position sits as (textblock number, offset) within [from, to). */
function textAnchor(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  pos: number,
) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const start = $pos.start();
  let index = 0;
  let found = -1;
  doc.nodesBetween(from, to, (node, nodePos) => {
    if (found >= 0) return false;
    if (!node.isTextblock) return true;
    if (nodePos + 1 === start) found = index;
    index++;
    return false;
  });
  return found < 0 ? null : { index: found, offset: $pos.parentOffset };
}
function anchorPosition(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  anchor: { index: number; offset: number } | null,
) {
  if (!anchor) return null;
  let index = 0;
  let result: number | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (result !== null) return false;
    if (!node.isTextblock) return true;
    if (index === anchor.index)
      result = pos + 1 + Math.min(anchor.offset, node.content.size);
    index++;
    return false;
  });
  return result;
}

/**
 * Replace whole blocks with restructured ones (same textblocks, new wrappers),
 * keeping the selection on the same text so a follow-up command covers it too.
 */
function restructure(
  state: EditorState,
  from: number,
  to: number,
  content: ProseMirrorNode[],
): Transaction {
  const fragment = Fragment.fromArray(content);
  const { anchor, head } = state.selection;
  const anchorAt = textAnchor(state.doc, from, to, anchor);
  const headAt = textAnchor(state.doc, from, to, head);
  const tr = state.tr.replaceWith(from, to, fragment);
  const end = from + fragment.size;
  const newAnchor = anchorPosition(tr.doc, from, end, anchorAt);
  const newHead = anchorPosition(tr.doc, from, end, headAt);
  if (newAnchor !== null && newHead !== null)
    tr.setSelection(TextSelection.create(tr.doc, newAnchor, newHead));
  return tr;
}

/** Join a list with a neighbour of the same kind across the boundary at `pos`. */
function joinLists(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (
    before &&
    after &&
    before.type === after.type &&
    kindOf(before.type) &&
    canJoin(tr.doc, pos)
  )
    tr.join(pos);
}
function joinAround(tr: Transaction, from: number, to: number) {
  joinLists(tr, to);
  joinLists(tr, from);
}

/** The selected items of the list at `depth` lifted out to plain blocks. */
function unwrapItems(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
) {
  const { $from, $to } = state.selection;
  const list = $from.node(depth);
  const pos = $from.before(depth);
  const first = $from.index(depth);
  const last = $to.index(depth);
  const before: ProseMirrorNode[] = [];
  const lifted: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((item, _offset, index) => {
    if (index < first) before.push(item);
    else if (index > last) after.push(item);
    else item.forEach((child) => lifted.push(child));
  });
  const out: ProseMirrorNode[] = [];
  if (before.length) out.push(list.type.create(list.attrs, before));
  out.push(...lifted);
  if (after.length)
    out.push(list.type.create(nextListAttrs(list, last), after));
  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  if (!parent.canReplace(index, index + 1, Fragment.fromArray(out)))
    return false;
  if (dispatch)
    dispatch(
      restructure(state, pos, pos + list.nodeSize, out).scrollIntoView(),
    );
  return true;
}

/** Attributes for the part of a split list after `last`; numbering continues. */
function nextListAttrs(list: ProseMirrorNode, last: number) {
  return list.type === orderedList
    ? { order: Number(list.attrs.order) + last + 1 }
    : null;
}

/** Convert the selected items of the list at `depth` into a list of `target`. */
function convertItems(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
  target: NodeType,
) {
  if (!dispatch) return true;
  const { $from, $to } = state.selection;
  const list = $from.node(depth);
  const pos = $from.before(depth);
  const first = $from.index(depth);
  const last = $to.index(depth);
  const item = itemFor(target);
  const before: ProseMirrorNode[] = [];
  const converted: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _offset, index) => {
    if (index < first) before.push(child);
    else if (index > last) after.push(child);
    else converted.push(convertItem(child, item));
  });
  const out: ProseMirrorNode[] = [];
  if (before.length) out.push(list.type.create(list.attrs, before));
  out.push(
    target.create(before.length ? null : { id: list.attrs.id }, converted),
  );
  if (after.length)
    out.push(list.type.create(nextListAttrs(list, last), after));
  const tr = restructure(state, pos, pos + list.nodeSize, out);
  joinAround(tr, pos, pos + Fragment.fromArray(out).size);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Wrap each selected paragraph (and the items of selected lists) as one list. */
function wrapBlocks(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  target: NodeType,
) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to);
  if (!range) return false;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const block = range.parent.child(index);
    if (block.type !== paragraph && !kindOf(block.type)) return false;
  }
  if (
    range.startIndex === range.endIndex ||
    !range.parent.canReplaceWith(range.startIndex, range.endIndex, target)
  )
    return false;
  if (!dispatch) return true;
  const item = itemFor(target);
  const items: ProseMirrorNode[] = [];
  let id: unknown = null;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const block = range.parent.child(index);
    if (block.type === paragraph) items.push(item.create(null, block));
    else {
      id ??= block.attrs.id;
      block.forEach((child) => items.push(convertItem(child, item)));
    }
  }
  const list = target.create({ id }, items);
  const tr = restructure(state, range.start, range.end, [list]);
  joinAround(tr, range.start, range.start + list.nodeSize);
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Bullet, numbered and checklist are exclusive (ported from Deltos's
 * `applyListType`): choosing the current kind lifts the selected items back
 * to paragraphs; bullet and numbered switch a whole list; switching to or
 * from a checklist converts the selected items; paragraphs become one item
 * each. Adjacent lists of the same kind join.
 */
export function applyListType(kind: ListKind): Command {
  const target = listTypes[kind];
  return (state, dispatch) => {
    const depth = sharedListDepth(state);
    if (depth < 0) return wrapBlocks(state, dispatch, target);
    const { $from } = state.selection;
    const list = $from.node(depth);
    const current = kindOf(list.type)!;
    if (current === kind) return unwrapItems(state, dispatch, depth);
    if (current !== "checklist" && kind !== "checklist") {
      if (dispatch) {
        const pos = $from.before(depth);
        const tr = state.tr.setNodeMarkup(pos, target, { id: list.attrs.id });
        joinAround(tr, pos, pos + list.nodeSize);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return convertItems(state, dispatch, depth, target);
  };
}

/** The slash palette's list entries start a list, never toggle one off. */
export function startList(kind: ListKind): Command {
  return (state, dispatch, view) =>
    currentListKind(state) === kind ||
    applyListType(kind)(state, dispatch, view);
}

/** Put a horizontal rule at the (empty) selection of `tr` and keep the caret after it. */
function placeDivider(tr: Transaction) {
  const $pos = tr.selection.$from;
  const block = $pos.parent;
  const container = $pos.node($pos.depth - 1);
  const index = $pos.index($pos.depth - 1);
  const rule = horizontalRule.create();
  const fits = container.canReplaceWith(index, index, horizontalRule);
  if (block.content.size === 0 && fits) {
    // An empty line: the rule goes above it and typing continues there.
    tr.insert($pos.before(), rule);
  } else if ($pos.parentOffset === block.content.size) {
    const after = $pos.after();
    tr.insert(after, [rule, paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, after + rule.nodeSize + 1));
  } else if ($pos.parentOffset === 0 && fits) {
    tr.insert($pos.before(), rule);
  } else {
    tr.split($pos.pos);
    tr.insert($pos.pos + 1, rule);
  }
  return tr;
}

function canDivide(state: EditorState) {
  const { $from, $to } = state.selection;
  return (
    $from.parent.isTextblock &&
    !$from.parent.type.spec.code &&
    $to.parent.isTextblock &&
    !$to.parent.type.spec.code
  );
}

/** Toolbar Divider and the `---` shortcut: insert the existing horizontal rule. */
export const insertDivider: Command = (state, dispatch) => {
  if (!canDivide(state)) return false;
  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    dispatch(placeDivider(tr).scrollIntoView());
  }
  return true;
};

/** `---` typed alone on a line becomes a divider (an input-rule handler). */
export function dividerRule(
  state: EditorState,
  start: number,
  end: number,
): Transaction | null {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== paragraph || $start.parentOffset !== 0)
    return null;
  if ($start.parent.content.size !== end - start) return null;
  const container = $start.node($start.depth - 1);
  const index = $start.index($start.depth - 1);
  if (!container.canReplaceWith(index, index, horizontalRule)) return null;
  return placeDivider(state.tr.delete(start, end));
}

/** Shift-Enter: a line break inside the block (a newline in code). */
export const insertHardBreak: Command = chainCommands(
  newlineInCode,
  (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.canReplaceWith($from.index(), $from.index(), hardBreak))
      return false;
    if (dispatch)
      dispatch(
        state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView(),
      );
    return true;
  },
);

/** The last place text can go, without changing the document. */
export function endSelection(doc: ProseMirrorNode) {
  return Selection.findFrom(doc.resolve(doc.content.size), -1, true);
}

/**
 * Tapping below the text: put the caret at the end. A note that ends in a
 * divider or image gets an empty line after it to type into.
 */
export const selectEnd: Command = (state, dispatch) => {
  const tr = state.tr;
  const last = state.doc.lastChild;
  if (last && last.isAtom)
    tr.insert(state.doc.content.size, paragraph.create());
  const end = endSelection(tr.doc);
  if (!end) return false;
  if (dispatch) dispatch(tr.setSelection(end).scrollIntoView());
  return true;
};
