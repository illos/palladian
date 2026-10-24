import { textDocument } from "./document";

/**
 * File notes (plan 08 B4, D103). A file note is an ordinary note: its first
 * line is its title (the file's name when it was made; renaming means
 * editing that line), its next block is a file, and text may follow. There
 * is no note kind for it: whether a note is a file note is read from its
 * document, here for the note list and in the editor for the note view.
 *
 * This module is light on purpose (no editor or schema code): the note list
 * uses it on cached documents in the startup bundle.
 */

/** Uploads are at most 25 MB (B1). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Server object IDs, as `attachment:<id>` sources and file blocks hold them. */
const OBJECT_ID = /^[a-z0-9]{16,64}$/;
const ATTACHMENT = /^attachment:([a-z0-9]{16,64})$/;

/** The file a file note shows. */
export interface FileNoteFile {
  /** A file block, or an image showing an uploaded picture. */
  kind: "file" | "image";
  objectId: string;
  /** The file's name (an image's description). */
  name: string;
  /** Empty for images, whose blocks do not record it. */
  mimeType: string;
  /** In bytes; null when the block does not record it (images). */
  size: number | null;
}

interface JsonNode {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
}
const isNode = (value: unknown): value is JsonNode =>
  typeof value === "object" && value !== null;
const children = (node: JsonNode): JsonNode[] =>
  Array.isArray(node.content) ? node.content.filter(isNode) : [];

/** The attachment a block (as JSON) shows, if it is one. */
function attachmentOf(node: JsonNode): FileNoteFile | null {
  const attrs = node.attrs ?? {};
  if (node.type === "file") {
    const objectId = attrs.objectId;
    if (typeof objectId !== "string" || !OBJECT_ID.test(objectId)) return null;
    return {
      kind: "file",
      objectId,
      name: typeof attrs.name === "string" ? attrs.name : "",
      mimeType: typeof attrs.mimeType === "string" ? attrs.mimeType : "",
      size: typeof attrs.size === "number" ? attrs.size : null,
    };
  }
  if (node.type === "image") {
    const match =
      typeof attrs.src === "string" ? ATTACHMENT.exec(attrs.src) : null;
    if (!match) return null;
    return {
      kind: "image",
      objectId: match[1]!,
      name: typeof attrs.alt === "string" ? attrs.alt : "",
      mimeType: "",
      size: null,
    };
  }
  return null;
}

/** How many image and file blocks a subtree holds, counting up to two. */
function mediaCount(node: JsonNode, limit = 2): number {
  let count = node.type === "image" || node.type === "file" ? 1 : 0;
  for (const child of children(node)) {
    if (count >= limit) break;
    count += mediaCount(child, limit - count);
  }
  return count;
}

/**
 * The file a document is a file note of, or null. A file note is a title
 * line, then an uploaded file (a file block or an attachment image), then
 * optional text: no other image or file anywhere.
 */
export function fileNoteFile(doc: unknown): FileNoteFile | null {
  if (!isNode(doc) || doc.type !== "doc") return null;
  const blocks = children(doc);
  const title = blocks[0];
  const second = blocks[1];
  if (!title || !second) return null;
  if (title.type !== "paragraph" && title.type !== "heading") return null;
  const file = attachmentOf(second);
  if (!file || mediaCount(doc) !== 1) return null;
  return file;
}

/** `fileNoteFile` of a stored document (JSON text); null if it is not one. */
export function fileNoteOf(document: string): FileNoteFile | null {
  try {
    return fileNoteFile(JSON.parse(document));
  } catch {
    return null;
  }
}

/** "2.4 MB", "512 KB", "12 B". */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A short type label: "PDF", "PNG", or the extension. */
export function typeLabel(name: string, mimeType: string) {
  if (mimeType === "application/pdf") return "PDF";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  if (/^[A-Za-z0-9]{1,5}$/.test(extension)) return extension.toUpperCase();
  return mimeType.startsWith("image/") ? "Image" : "File";
}

/**
 * A file note's type and size for the note list: "PDF · 2.4 MB". Images
 * record neither, so their name gives the type, and `size` (the bytes this
 * page holds, if any) the size.
 */
export function fileNoteLabel(file: FileNoteFile, size?: number | null) {
  const bytes = file.size ?? size ?? null;
  return [
    typeLabel(file.name, file.kind === "image" ? "image/" : file.mimeType),
    bytes !== null ? formatSize(bytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A file note's preview without the file's name it starts with (the note
 * list shows the type and size instead): the text after the file.
 */
export function fileNoteRest(preview: string, file: FileNoteFile) {
  // Previews collapse runs of spaces.
  const name = file.name.replace(/\s+/g, " ").trim();
  if (preview.startsWith(name)) return preview.slice(name.length).trim();
  // The preview is cut short inside a long name.
  return name.startsWith(preview) ? "" : preview;
}

/** A file's name as uploaded and as its note's title: never empty, one line. */
export function fileTitle(file: { name: string; type: string }) {
  const name = file.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return name || (file.type.startsWith("image/") ? "image" : "file");
}

/**
 * The new note for a file, before its upload: its title line, the file's
 * name. Or why the file cannot be uploaded at all, so no note is made for
 * it (the limits B3's uploads refuse with).
 */
export function fileNoteStart(
  file: File,
): { title: string; document: string } | { refused: string } {
  if (file.size === 0) return { refused: "This file is empty." };
  if (file.size > MAX_FILE_BYTES)
    return { refused: "Files can be at most 25 MB." };
  const title = fileTitle(file);
  return { title, document: textDocument([title]) };
}

/**
 * A file waiting for its new note's editor (B4): the app makes the note,
 * opens it, and the editor that shows it takes the file once and uploads it
 * after the title line, through B3's uploads.
 */
export interface FileNoteUpload {
  /** The account and session generation the note was made in. */
  accountId: string;
  generation: number;
  /** The new note's server ID. */
  noteId: string;
  title: string;
  /** The file, the first time only; null after. */
  take(): File | null;
}
