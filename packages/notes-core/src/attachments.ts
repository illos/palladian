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

/**
 * Whether content uses what came with files (B1/B2): a file block, an image
 * width, or an image showing an uploaded object. Clients built before B2 do
 * not know file blocks at all, so the backend refuses such new content until
 * files are enabled (FILES_WRITES_ENABLED, review round 3).
 */
export function usesFileFeatures(content: ProseMirrorNode | Fragment): boolean {
  let found = false;
  content.descendants((node) => {
    if (found) return false;
    if (node.type.name === "file") found = true;
    else if (node.type.name === "image")
      found =
        node.attrs.width !== null ||
        attachmentObjectId(node.attrs.src) !== null;
    return !found && !node.isTextblock;
  });
  return found;
}

/** Whether a step brings in content `usesFileFeatures` would flag. */
export function stepUsesFileFeatures(step: Step): boolean {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep)
    return usesFileFeatures(step.slice.content);
  if (step instanceof AttrStep) {
    if (step.attr === "width") return step.value !== null;
    if (step.attr === "src") return attachmentObjectId(step.value) !== null;
    if (step.attr === "objectId") return true;
  }
  return false;
}

/**
 * The file features a document already has, by kind (rounds 4 and 5: the
 * gate allows these). An object shown as an image does not make a file block
 * for it known, or the reverse: clients before B2 open the one, not the other.
 */
export interface FileFeatures {
  /** Objects shown as file blocks. */
  files: Set<string>;
  /** Objects shown as images (`attachment:` sources). */
  images: Set<string>;
  /** Image widths, keyed by source and width. */
  widths: Set<string>;
}

function widthKey(src: unknown, width: unknown) {
  return `${String(src)}\u0000${String(width)}`;
}

/** Whether `existing` already uses this image width (same source and width). */
export function knownImageWidth(
  existing: FileFeatures,
  src: unknown,
  width: unknown,
): boolean {
  return existing.widths.has(widthKey(src, width));
}

export function fileFeatures(
  content: ProseMirrorNode | Fragment | null,
): FileFeatures {
  const features: FileFeatures = {
    files: new Set(),
    images: new Set(),
    widths: new Set(),
  };
  if (content) mergeFileFeatures(features, content);
  return features;
}

/** Add the file features of `content` to `features`. */
export function mergeFileFeatures(
  features: FileFeatures,
  content: ProseMirrorNode | Fragment,
): FileFeatures {
  content.descendants((node) => {
    if (node.type.name === "file")
      features.files.add(String(node.attrs.objectId));
    else if (node.type.name === "image") {
      const objectId = attachmentObjectId(node.attrs.src);
      if (objectId !== null) features.images.add(objectId);
      if (node.attrs.width !== null)
        features.widths.add(widthKey(node.attrs.src, node.attrs.width));
    }
    return !node.isTextblock;
  });
  return features;
}

/**
 * Whether content has file features `existing` lacks: a file block or an
 * image for an object not already shown that way, or an image width not
 * already used for that source. Keeping an identical file block or sized
 * image is not new.
 */
export function addsFileFeatures(
  content: ProseMirrorNode | Fragment,
  existing: FileFeatures,
): boolean {
  let found = false;
  content.descendants((node) => {
    if (found) return false;
    if (node.type.name === "file")
      found = !existing.files.has(String(node.attrs.objectId));
    else if (node.type.name === "image") {
      const objectId = attachmentObjectId(node.attrs.src);
      found =
        (objectId !== null && !existing.images.has(objectId)) ||
        (node.attrs.width !== null &&
          !existing.widths.has(widthKey(node.attrs.src, node.attrs.width)));
    }
    return !found && !node.isTextblock;
  });
  return found;
}

/** Whether a step, applied to `doc`, brings in file features `existing` lacks. */
export function stepAddsFileFeatures(
  step: Step,
  doc: ProseMirrorNode,
  existing: FileFeatures,
): boolean {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep)
    return addsFileFeatures(step.slice.content, existing);
  if (step instanceof AttrStep) {
    const node = doc.nodeAt(step.pos);
    if (step.attr === "src") {
      const objectId = attachmentObjectId(step.value);
      if (objectId !== null && !existing.images.has(objectId)) return true;
      const width = node?.attrs.width ?? null;
      return (
        width !== null && !existing.widths.has(widthKey(step.value, width))
      );
    }
    if (step.attr === "width")
      return (
        step.value !== null &&
        !existing.widths.has(widthKey(node?.attrs.src, step.value))
      );
    if (step.attr === "objectId")
      return !existing.files.has(String(step.value));
  }
  return false;
}
