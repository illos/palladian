import {
  Slice,
  type Fragment,
  type Node as ProseMirrorNode,
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
  | { kind: "attrs"; pos: number; attrs: Record<string, unknown> };

const LCS_LIMIT = 4_000_000;

/** Index pairs of a longest common subsequence, or null when too large. */
function commonPairs(a: string[], b: string[]): [number, number][] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const middle = middlePairs(
    a.slice(head, a.length - tail),
    b.slice(head, b.length - tail),
  );
  if (!middle) return null;
  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  for (const [i, j] of middle) pairs.push([head + i, head + j]);
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

function middlePairs(a: string[], b: string[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_LIMIT) return null;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? table[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(
              table[(i + 1) * (m + 1) + j]!,
              table[i * (m + 1) + j + 1]!,
            );
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!)
      i++;
    else j++;
  }
  return pairs;
}

/** One unit per inline position: a character with its marks, or an inline leaf. */
function inlineUnits(node: ProseMirrorNode): string[] {
  const units: string[] = [];
  node.forEach((child) => {
    const marks = JSON.stringify(child.marks.map((mark) => mark.toJSON()));
    if (child.isText) for (const char of child.text!) units.push(char + marks);
    else units.push("\u0000" + contentKey(child) + marks);
  });
  return units;
}

function sameAttrs(a: ProseMirrorNode, b: ProseMirrorNode) {
  const strip = ({ id: _id, ...rest }: Record<string, unknown>) => rest;
  return JSON.stringify(strip(a.attrs)) === JSON.stringify(strip(b.attrs));
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
  const pairs = commonPairs(unitsA, unitsB);
  if (!pairs) {
    ops.push({
      kind: "replace",
      from: startA,
      to: startA + a.content.size,
      slice: target.slice(startB, startB + b.content.size),
    });
    return;
  }
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [
    ...pairs,
    [unitsA.length, unitsB.length] as [number, number],
  ]) {
    if (pi > i || pj > j)
      ops.push({
        kind: "replace",
        from: startA + i,
        to: startA + pi,
        slice: target.slice(startB + j, startB + pj),
      });
    i = pi + 1;
    j = pj + 1;
  }
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
  const pairs =
    commonPairs(childrenA.map(contentKey), childrenB.map(contentKey)) ?? [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [
    ...pairs,
    [childrenA.length, childrenB.length] as [number, number],
  ]) {
    const runA = childrenA.slice(i, pi);
    const runB = childrenB.slice(j, pj);
    if (
      runA.length &&
      runA.length === runB.length &&
      runA.every((node, k) => node.type === runB[k]!.type)
    )
      runA.forEach((node, k) =>
        diffNode(
          node,
          runB[k]!,
          offsetsA[i + k]!,
          offsetsB[j + k]!,
          target,
          ops,
        ),
      );
    else if (runA.length || runB.length)
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

function diffNode(
  a: ProseMirrorNode,
  b: ProseMirrorNode,
  posA: number,
  posB: number,
  target: ProseMirrorNode,
  ops: DiffOp[],
) {
  if (!sameAttrs(a, b)) {
    const { id: _id, ...attrs } = b.attrs;
    ops.push({ kind: "attrs", pos: posA, attrs });
  }
  if (a.isTextblock) diffInline(a, b, posA + 1, posB + 1, target, ops);
  else if (!a.isLeaf) diffChildren(a, b, posA + 1, posB + 1, target, ops);
}

/**
 * Steps turning `from` into `to`, one per changed region, so that rebasing
 * them over others' edits preserves untouched text between local changes.
 * Falls back to a single replacement when the fine diff cannot reproduce `to`.
 */
export function diffSteps(from: ProseMirrorNode, to: ProseMirrorNode): Step[] {
  if (contentKey(from) === contentKey(to)) return [];
  const ops: DiffOp[] = [];
  diffChildren(from, to, 0, 0, to, ops);
  const position = (op: DiffOp) => (op.kind === "replace" ? op.from : op.pos);
  ops.sort(
    (x, y) => position(y) - position(x) || (x.kind === "replace" ? -1 : 1),
  );
  const tr = new Transform(from);
  try {
    for (const op of ops) {
      if (op.kind === "replace") tr.replace(op.from, op.to, op.slice);
      else
        for (const [key, value] of Object.entries(op.attrs))
          if (tr.doc.nodeAt(op.pos)?.attrs[key] !== value)
            tr.setNodeAttribute(op.pos, key, value);
    }
    if (contentKey(tr.doc) === contentKey(to)) return tr.steps;
  } catch {
    /* fall back below */
  }
  const single = diffStep(from, to);
  return single ? [single] : [];
}
