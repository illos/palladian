import { notesSchema } from "@palladian/notes-core/schema";
import {
  Fragment,
  NodeRange,
  Slice,
  type Attrs,
  type Node as ProseMirrorNode,
  type NodeType,
  type ResolvedPos,
} from "prosemirror-model";
import {
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import {
  canJoin,
  canSplit,
  findWrapping,
  ReplaceAroundStep,
} from "prosemirror-transform";
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
function sharedListDepth($from: ResolvedPos, $to: ResolvedPos) {
  for (let depth = Math.min($from.depth, $to.depth); depth > 0; depth--)
    if (
      kindOf($from.node(depth).type) &&
      $from.before(depth) === $to.before(depth)
    )
      return depth;
  return -1;
}

/*
 * List changes use only steps that keep the text they move (wrapping,
 * lifting, splitting, joining, retyping), as prosemirror-schema-list does, so
 * a collaborator's concurrent typing inside the list survives a rebase.
 */

/**
 * Lift the items in `range` out of their list: their content moves to the
 * list's level and the rest of the list stays around it, a numbered list
 * counting on. Returns where the lifted blocks now are. Ported from
 * prosemirror-schema-list's `liftOutOfList`, for every list kind.
 */
function liftItems(tr: Transaction, range: NodeRange) {
  const list = range.parent;
  const steps = tr.steps.length;
  for (let pos = range.end, i = range.endIndex - 1; i > range.startIndex; i--) {
    pos -= list.child(i).nodeSize;
    tr.delete(pos - 1, pos + 1);
  }
  const $start = tr.doc.resolve(range.start);
  const item = $start.nodeAfter;
  if (
    !item ||
    tr.mapping.slice(steps).map(range.end) !== range.start + item.nodeSize
  )
    return null;
  const atStart = range.startIndex === 0;
  const atEnd = range.endIndex === list.childCount;
  const parent = $start.node(-1);
  const index = $start.index(-1);
  const rest = atEnd ? Fragment.empty : Fragment.from(list);
  if (
    !parent.canReplace(
      index + (atStart ? 0 : 1),
      index + 1,
      item.content.append(rest),
    )
  )
    return null;
  const start = $start.pos;
  const end = start + item.nodeSize;
  const after = list.type.create(
    list.type === orderedList
      ? { order: Number(list.attrs.order) + range.endIndex }
      : null,
  );
  tr.step(
    new ReplaceAroundStep(
      start - (atStart ? 1 : 0),
      end + (atEnd ? 1 : 0),
      start + 1,
      end - 1,
      new Slice(
        (atStart
          ? Fragment.empty
          : Fragment.from(list.copy(Fragment.empty))
        ).append(atEnd ? Fragment.empty : Fragment.from(after)),
        atStart ? 0 : 1,
        atEnd ? 0 : 1,
      ),
      atStart ? 0 : 1,
    ),
  );
  const from = atStart ? start - 1 : start + 1;
  return { from, to: from + item.content.size };
}

/**
 * Wrap the blocks between two block boundaries in a list of `type`, one item
 * per block where an item may start (prosemirror-schema-list's `wrapInList`).
 */
function wrapBlocks(tr: Transaction, from: number, to: number, type: NodeType) {
  const range = tr.doc.resolve(from).blockRange(tr.doc.resolve(to));
  const wrappers = range && findWrapping(range, type);
  if (!range || !wrappers) return false;
  tr.wrap(range, wrappers);
  let pos = range.start + wrappers.length;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    if (index > range.startIndex && canSplit(tr.doc, pos, 1)) {
      tr.split(pos, 1);
      pos += 2;
    }
    pos += range.parent.child(index).nodeSize;
  }
  return true;
}

/** Join neighbouring lists of the same kind at block boundaries in [from, to]. */
function joinLists(tr: Transaction, from: number, to: number) {
  const $from = tr.doc.resolve(from);
  const parent = $from.parent;
  const start = $from.start();
  const joins: number[] = [];
  parent.forEach((child, offset, index) => {
    const pos = start + offset;
    const before = index > 0 ? parent.child(index - 1) : null;
    if (
      pos >= from &&
      pos <= to &&
      before?.type === child.type &&
      kindOf(child.type)
    )
      joins.push(pos);
  });
  for (const pos of joins.reverse()) if (canJoin(tr.doc, pos)) tr.join(pos);
}

/** Make the whole list at `pos` a list of `kind`. */
function convertList(tr: Transaction, pos: number, kind: ListKind) {
  const list = tr.doc.nodeAt(pos)!;
  const current = kindOf(list.type);
  if (current === kind) return true;
  if (current !== "checklist" && kind !== "checklist") {
    tr.setNodeMarkup(pos, listTypes[kind], { id: list.attrs.id });
    return true;
  }
  const $inside = tr.doc.resolve(pos + 1);
  const lifted = liftItems(
    tr,
    new NodeRange(
      $inside,
      tr.doc.resolve(pos + list.nodeSize - 1),
      $inside.depth,
    ),
  );
  return !!lifted && wrapBlocks(tr, lifted.from, lifted.to, listTypes[kind]);
}

/**
 * Bullet, numbered and checklist are exclusive (ported from Deltos's
 * `applyListType`): choosing the current kind lifts the selected items back
 * to plain blocks; bullet and numbered switch a whole list; switching to or
 * from a checklist converts the selected items; paragraphs become one item
 * each. Adjacent lists of the same kind join.
 */
export function applyListType(kind: ListKind): Command {
  const target = listTypes[kind];
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const depth = sharedListDepth($from, $to);
    const tr = state.tr;
    if (depth > 0) {
      if (!dispatch) return true;
      const list = $from.node(depth);
      const items = new NodeRange($from, $to, depth);
      const current = kindOf(list.type)!;
      if (current === kind) {
        if (!liftItems(tr, items)) return false;
      } else if (current !== "checklist" && kind !== "checklist") {
        const pos = $from.before(depth);
        convertList(tr, pos, kind);
        joinLists(tr, pos, pos + list.nodeSize);
      } else {
        const lifted = liftItems(tr, items);
        if (!lifted) return false;
        const steps = tr.steps.length;
        if (!wrapBlocks(tr, lifted.from, lifted.to, target)) return false;
        joinLists(tr, lifted.from, tr.mapping.slice(steps).map(lifted.to));
      }
      dispatch(tr.scrollIntoView());
      return true;
    }
    // No list around the selection: its paragraphs, and any lists among
    // them, become one list.
    const range = $from.blockRange($to);
    if (
      !range ||
      !range.parent.canReplaceWith(range.startIndex, range.endIndex, target)
    )
      return false;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const block = range.parent.child(index);
      if (block.type !== paragraph && !kindOf(block.type)) return false;
    }
    if (!dispatch) return true;
    // From the last block back, so earlier positions stay valid.
    let end = range.end;
    let run: number | null = null;
    for (let index = range.endIndex - 1; index >= range.startIndex; index--) {
      const block = range.parent.child(index);
      const start = end - block.nodeSize;
      if (block.type === paragraph) run ??= end;
      else {
        if (run !== null && !wrapBlocks(tr, end, run, target)) return false;
        run = null;
        if (!convertList(tr, start, kind)) return false;
      }
      end = start;
    }
    if (run !== null && !wrapBlocks(tr, range.start, run, target)) return false;
    joinLists(tr, range.start, tr.mapping.map(range.end));
    dispatch(tr.scrollIntoView());
    return true;
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
