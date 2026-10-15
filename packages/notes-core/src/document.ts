import {
  Slice,
  type Attrs,
  type Fragment,
  type Node as ProseMirrorNode,
  type NodeType,
} from "prosemirror-model";
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  Transform,
  type Step,
} from "prosemirror-transform";
import { assignBlockIds } from "./ids.ts";
import {
  assertSafeDocument,
  assertSafeFragment,
  assertSafeMark,
  assertSafeNode,
  notesSchema,
  UnsafeDocumentError,
} from "./schema.ts";

/** Serialized document ceiling, under Convex's 1 MiB document limit. */
export const DOC_JSON_LIMIT = 700_000;

export function emptyDoc(): ProseMirrorNode {
  const doc = notesSchema.topNodeType.createAndFill()!;
  return assignBlockIds(new Transform(doc)).doc;
}

/** Validate a stored or submitted document: structure and every attribute. */
export function parseStoredDoc(json: string): ProseMirrorNode {
  if (json.length > DOC_JSON_LIMIT) throw new Error("Note is too large.");
  const doc = notesSchema.nodeFromJSON(JSON.parse(json));
  if (doc.type !== notesSchema.topNodeType)
    throw new Error("Note document root required.");
  doc.check();
  assertSafeDocument(doc);
  return doc;
}

/**
 * One step turning `from` into `to`, replacing only the changed range. Used to
 * submit a locally saved version as an edit instead of assuming acceptance.
 */
export function diffStep(
  from: ProseMirrorNode,
  to: ProseMirrorNode,
): Step | null {
  const start = from.content.findDiffStart(to.content);
  if (start === null) return null;
  const end = from.content.findDiffEnd(to.content)!;
  let endA = end.a;
  let endB = end.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const precise = new ReplaceStep(start, endA, to.slice(start, endB));
  const result = precise.apply(from);
  if (result.doc && result.doc.eq(to)) return precise;
  return new ReplaceStep(0, from.content.size, new Slice(to.content, 0, 0));
}

/**
 * Structural check of the part of `doc` between `from` and `to`: every node
 * overlapping the range, recursively, and the content of its ancestors.
 */
function checkChangedRange(doc: ProseMirrorNode, from: number, to: number) {
  try {
    const $from = doc.resolve(from);
    const depth = $from.sharedDepth(to);
    for (let d = 0; d <= depth; d++) {
      const node = $from.node(d);
      if (!node.type.validContent(node.content)) throw new Error();
    }
    const parent = $from.node(depth);
    const start = $from.start(depth);
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (pos <= to && pos + child.nodeSize >= from) child.check();
    });
  } catch {
    throw new UnsafeDocumentError("The edit would produce malformed content.");
  }
}

/**
 * Apply one step and validate only what it introduced, so every intermediate
 * revision of a batch is as safe as a validated document (given a safe start).
 */
export function applySafeStep(
  doc: ProseMirrorNode,
  step: Step,
): ProseMirrorNode {
  if (step instanceof DocAttrStep)
    throw new UnsafeDocumentError("Notes have no document attributes.");
  const replaces =
    step instanceof ReplaceStep || step instanceof ReplaceAroundStep;
  if (replaces) assertSafeFragment(step.slice.content);
  if (step instanceof AddMarkStep || step instanceof AddNodeMarkStep)
    assertSafeMark(step.mark);
  const result = step.apply(doc);
  if (!result.doc)
    throw new Error(result.failed ?? "A step could not be applied.");
  if (replaces) {
    // Check the structure of what changed in the result. A slice alone can't
    // be checked: open slices and wrapping gaps are completed by the step.
    const map = step.getMap();
    checkChangedRange(result.doc, map.map(step.from, -1), map.map(step.to, 1));
  }
  if (step instanceof AttrStep) {
    const node = result.doc.nodeAt(step.pos);
    if (node) assertSafeNode(node);
  }
  return result.doc;
}

/** A node's JSON without block IDs: equal content regardless of identity. */
export function contentKey(node: ProseMirrorNode | Fragment): string {
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).flatMap(([key, item]) =>
              key === "id" ? [] : [[key, strip(item)]],
            ),
          )
        : value;
  return JSON.stringify(strip(node.toJSON()));
}

type DiffOp =
  | { kind: "replace"; from: number; to: number; slice: Slice }
  | { kind: "attrs"; pos: number; attrs: Record<string, unknown> }
  | { kind: "markup"; pos: number; type: NodeType; attrs: Attrs };

/** More differences than can be aligned piece by piece. */
class DiffBudgetExceeded extends Error {}

const MAX_EDITS = 2_000;

/** Index pairs both sequences keep, from a shortest edit script. */
function commonPairs(a: string[], b: string[]): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  for (const [i, j] of editScript(
    a.slice(head, a.length - tail),
    b.slice(head, b.length - tail),
  ))
    pairs.push([head + i, head + j]);
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/**
 * Myers' O((N+M)D) diff: cost grows with the number of differences, not the
 * length, so a long paragraph with a few edits stays cheap. `trace[d]` holds
 * the furthest x reached on each diagonal k (index k + d) after d edits.
 */
function editScript(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  // The edit reaching diagonal k at step d: down from k + 1 or right from
  // k - 1, whichever goes further while staying inside both sequences.
  const choose = (prev: Int32Array, k: number, d: number) => {
    const at = (kk: number) =>
      kk < -(d - 1) || kk > d - 1 ? -1 : prev[kk + d - 1]!;
    const down = at(k + 1);
    const right = at(k - 1);
    const viaDown = down >= 0 && down - k <= m ? down : -1;
    const viaRight = right >= 0 && right + 1 <= n ? right + 1 : -1;
    if (viaDown < 0 && viaRight < 0) return null;
    return viaDown >= viaRight
      ? { x: viaDown, from: k + 1 }
      : { x: viaRight, from: k - 1 };
  };
  const trace: Int32Array[] = [];
  for (let d = 0; ; d++) {
    if (d > MAX_EDITS) throw new DiffBudgetExceeded();
    const current = new Int32Array(2 * d + 1).fill(-1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else {
        const step = choose(trace[d - 1]!, k, d);
        if (!step) continue;
        x = step.x;
      }
      let y = x - k;
      if (y < 0 || y > m) continue;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      current[k + d] = x;
      if (x === n && y === m) {
        trace.push(current);
        return backtrack(trace, n, m, choose);
      }
    }
    trace.push(current);
  }
}

function backtrack(
  trace: Int32Array[],
  n: number,
  m: number,
  choose: (
    prev: Int32Array,
    k: number,
    d: number,
  ) => { x: number; from: number } | null,
): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const k = x - y;
    const step = choose(trace[d - 1]!, k, d)!;
    while (x > step.x) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = trace[d - 1]![step.from + d - 1]!;
    y = x - step.from;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/**
 * One unit per inline position: a character (a whole code point, so surrogate
 * pairs are never split) with its marks, or an inline leaf. Sizes are in
 * ProseMirror positions, which count UTF-16 code units.
 */
function inlineUnits(node: ProseMirrorNode) {
  const keys: string[] = [];
  const offsets: number[] = [0];
  node.forEach((child) => {
    const marks = JSON.stringify(child.marks.map((mark) => mark.toJSON()));
    if (child.isText)
      for (const char of child.text!) {
        keys.push(char + marks);
        offsets.push(offsets.at(-1)! + char.length);
      }
    else {
      keys.push("\u0000" + contentKey(child) + marks);
      offsets.push(offsets.at(-1)! + child.nodeSize);
    }
  });
  return { keys, offsets };
}

function sameAttrs(a: ProseMirrorNode, b: ProseMirrorNode) {
  const strip = ({ id: _id, ...rest }: Record<string, unknown>) => rest;
  return JSON.stringify(strip(a.attrs)) === JSON.stringify(strip(b.attrs));
}

/** Replace each unmatched gap between kept pairs with the target's content. */
function replaceGaps(
  pairs: [number, number][],
  lengthA: number,
  lengthB: number,
  offsetsA: number[],
  offsetsB: number[],
  target: ProseMirrorNode,
  ops: DiffOp[],
  onGap?: (i: number, pi: number, j: number, pj: number) => boolean,
) {
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [lengthA, lengthB] as [number, number]]) {
    if ((pi > i || pj > j) && !onGap?.(i, pi, j, pj))
      ops.push({
        kind: "replace",
        from: offsetsA[i]!,
        to: offsetsA[pi]!,
        slice: target.slice(offsetsB[j]!, offsetsB[pj]!),
      });
    i = pi + 1;
    j = pj + 1;
  }
}

function diffInline(
  a: ProseMirrorNode,
  b: ProseMirrorNode,
  startA: number,
  startB: number,
  target: ProseMirrorNode,
  ops: DiffOp[],
) {
  const unitsA = inlineUnits(a);
  const unitsB = inlineUnits(b);
  replaceGaps(
    commonPairs(unitsA.keys, unitsB.keys),
    unitsA.keys.length,
    unitsB.keys.length,
    unitsA.offsets.map((offset) => startA + offset),
    unitsB.offsets.map((offset) => startB + offset),
    target,
    ops,
  );
}

function childOffsets(node: ProseMirrorNode, start: number) {
  const offsets: number[] = [];
  let pos = start;
  node.forEach((child) => {
    offsets.push(pos);
    pos += child.nodeSize;
  });
  offsets.push(pos);
  return offsets;
}

/** Blocks that can turn into each other while keeping their content. */
function blockKind(node: ProseMirrorNode) {
  if (node.isTextblock) return "textblock";
  if (node.isLeaf) return "leaf:" + node.type.name;
  return `${node.type.spec.content ?? ""}|${node.type.spec.group ?? ""}`;
}

function diffChildren(
  a: ProseMirrorNode,
  b: ProseMirrorNode,
  startA: number,
  startB: number,
  target: ProseMirrorNode,
  ops: DiffOp[],
) {
  const childrenA: ProseMirrorNode[] = [];
  const childrenB: ProseMirrorNode[] = [];
  a.forEach((child) => childrenA.push(child));
  b.forEach((child) => childrenB.push(child));
  const offsetsA = childOffsets(a, startA);
  const offsetsB = childOffsets(b, startB);
  // Identical blocks first; then, among the changed ones, blocks of the same
  // kind are paired and diffed inside, so unchanged text in them survives.
  replaceGaps(
    commonPairs(childrenA.map(contentKey), childrenB.map(contentKey)),
    childrenA.length,
    childrenB.length,
    offsetsA,
    offsetsB,
    target,
    ops,
    (i, pi, j, pj) => {
      const runA = childrenA.slice(i, pi);
      const runB = childrenB.slice(j, pj);
      const kinds = commonPairs(runA.map(blockKind), runB.map(blockKind));
      for (const [x, y] of kinds)
        diffNode(
          runA[x]!,
          runB[y]!,
          offsetsA[i + x]!,
          offsetsB[j + y]!,
          target,
          ops,
        );
      replaceGaps(
        kinds,
        runA.length,
        runB.length,
        offsetsA.slice(i, pi + 1),
        offsetsB.slice(j, pj + 1),
        target,
        ops,
      );
      return true;
    },
  );
}

function diffNode(
  a: ProseMirrorNode,
  b: ProseMirrorNode,
  posA: number,
  posB: number,
  target: ProseMirrorNode,
  ops: DiffOp[],
) {
  if (a.type !== b.type) {
    const attrs: Attrs =
      "id" in b.attrs && a.attrs.id !== undefined
        ? { ...b.attrs, id: a.attrs.id }
        : b.attrs;
    ops.push({ kind: "markup", pos: posA, type: b.type, attrs });
  } else if (!sameAttrs(a, b)) {
    const { id: _id, ...attrs } = b.attrs;
    ops.push({ kind: "attrs", pos: posA, attrs });
  }
  if (a.isTextblock && b.isTextblock)
    diffInline(a, b, posA + 1, posB + 1, target, ops);
  else if (!a.isLeaf && !b.isLeaf)
    diffChildren(a, b, posA + 1, posB + 1, target, ops);
}

/**
 * Steps turning `from` into `to`, one per changed region, so that rebasing
 * them over others' edits keeps unchanged text between local changes. Null
 * when the documents differ too much to align piece by piece, or the pieces
 * do not reproduce `to` exactly: callers must then keep both versions rather
 * than rebase a broad replacement.
 */
export function diffSteps(
  from: ProseMirrorNode,
  to: ProseMirrorNode,
): Step[] | null {
  if (contentKey(from) === contentKey(to)) return [];
  const ops: DiffOp[] = [];
  try {
    diffChildren(from, to, 0, 0, to, ops);
  } catch (error) {
    if (error instanceof DiffBudgetExceeded) return null;
    throw error;
  }
  // End to start, so earlier positions stay valid. At one position, change
  // the node there before inserting in front of it.
  const position = (op: DiffOp) => (op.kind === "replace" ? op.from : op.pos);
  ops.sort(
    (x, y) =>
      position(y) - position(x) ||
      (x.kind === "replace" ? 1 : 0) - (y.kind === "replace" ? 1 : 0),
  );
  const tr = new Transform(from);
  try {
    for (const op of ops) {
      if (op.kind === "replace") tr.replace(op.from, op.to, op.slice);
      else if (op.kind === "markup")
        tr.setNodeMarkup(op.pos, op.type, op.attrs);
      else
        for (const [key, value] of Object.entries(op.attrs))
          if (tr.doc.nodeAt(op.pos)?.attrs[key] !== value)
            tr.setNodeAttribute(op.pos, key, value);
    }
  } catch {
    return null;
  }
  return contentKey(tr.doc) === contentKey(to) ? tr.steps : null;
}
