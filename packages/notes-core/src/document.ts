import { Slice, type Node as ProseMirrorNode } from "prosemirror-model";
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
 * Apply one step and validate only what it introduced, so every intermediate
 * revision of a batch is as safe as a validated document (given a safe start).
 */
export function applySafeStep(
  doc: ProseMirrorNode,
  step: Step,
): ProseMirrorNode {
  if (step instanceof DocAttrStep)
    throw new UnsafeDocumentError("Notes have no document attributes.");
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep)
    assertSafeFragment(step.slice.content);
  if (step instanceof AddMarkStep || step instanceof AddNodeMarkStep)
    assertSafeMark(step.mark);
  const result = step.apply(doc);
  if (!result.doc)
    throw new Error(result.failed ?? "A step could not be applied.");
  if (step instanceof AttrStep) {
    const node = result.doc.nodeAt(step.pos);
    if (node) assertSafeNode(node);
  }
  return result.doc;
}
