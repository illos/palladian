import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { assignBlockIds } from "./ids.ts";
import { notesSchema } from "./schema.ts";

/** Serialized document ceiling, under Convex's 1 MiB document limit. */
export const DOC_JSON_LIMIT = 700_000;

export function emptyDoc(): ProseMirrorNode {
  const doc = notesSchema.topNodeType.createAndFill()!;
  return assignBlockIds(new Transform(doc)).doc;
}

/** Validate a stored or submitted document against the notes schema. */
export function parseStoredDoc(json: string): ProseMirrorNode {
  if (json.length > DOC_JSON_LIMIT) throw new Error("Note is too large.");
  const doc = notesSchema.nodeFromJSON(JSON.parse(json));
  if (doc.type !== notesSchema.topNodeType)
    throw new Error("Note document root required.");
  doc.check();
  return doc;
}
