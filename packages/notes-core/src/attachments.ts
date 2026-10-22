import type { Fragment, Node as ProseMirrorNode } from "prosemirror-model";
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
