import type { Node as ProseMirrorNode } from "prosemirror-model";

export const TITLE_LIMIT = 200;
export const PREVIEW_LIMIT = 160;

function leafText(node: ProseMirrorNode) {
  if (node.type.name === "image") return String(node.attrs.alt ?? "");
  // A file's name is searchable text, like an image's description.
  if (node.type.name === "file") return String(node.attrs.name ?? "");
  if (node.type.name === "hard_break") return "\n";
  return "";
}

/** Plain text with one line per block; used for search and previews. */
export function plainText(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, "\n", leafText);
}

/**
 * The first logical line is the title. An empty first line yields an empty
 * title, which interfaces display as "Untitled" without changing the body.
 */
export function deriveSummary(doc: ProseMirrorNode): {
  title: string;
  preview: string;
} {
  const text = plainText(doc);
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  const rest = newline < 0 ? "" : text.slice(newline + 1);
  return {
    title: first.trim().slice(0, TITLE_LIMIT),
    preview: rest.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT),
  };
}

export function displayTitle(title: string) {
  return title || "Untitled";
}
