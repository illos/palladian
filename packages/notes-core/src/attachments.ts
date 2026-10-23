import type { Fragment, Node as ProseMirrorNode } from "prosemirror-model";
import {
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from "prosemirror-transform";
import { attachmentObjectId, isObjectId } from "./schema.ts";

/**
 * The uploaded objects a document references, each once, in document order:
 * images with an `attachment:` source and file blocks. The backend records
 * these for every accepted revision (object lifecycle, D36–D42), so this is
 * the single definition of "references an object".
 */
export function attachmentIds(content: ProseMirrorNode | Fragment): string[] {
  const ids = new Set<string>();
  content.descendants((node) => {
    if (node.type.name === "image") {
      const objectId = attachmentObjectId(node.attrs.src);
      if (objectId) ids.add(objectId);
    } else if (node.type.name === "file" && isObjectId(node.attrs.objectId))
      ids.add(node.attrs.objectId);
    // Attachments are blocks; text never contains them.
    return !node.isTextblock;
  });
  return [...ids];
}

/**
 * The objects a step can bring into a document: those in the content a
 * replace step inserts, or the one an attribute step points an image or file
 * at. A document reached by applying steps references only objects of its
 * starting document or of these, so every intermediate revision's references
 * are covered without walking each revision.
 */
export function stepAttachmentIds(step: Step): string[] {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep)
    return attachmentIds(step.slice.content);
  if (step instanceof AttrStep) {
    if (step.attr === "src") {
      const objectId = attachmentObjectId(step.value);
      return objectId ? [objectId] : [];
    }
    if (step.attr === "objectId" && isObjectId(step.value)) return [step.value];
  }
  return [];
}
