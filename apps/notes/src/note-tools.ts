import type { ConvexReactClient } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import { docToMarkdown, notesSchema } from "@palladian/notes-core";
import { parseStoredDoc } from "@palladian/notes-core/document";
import { DOMSerializer } from "prosemirror-model";

/**
 * Note actions that need the editor schema or the backend API, loaded only
 * when one is used so the notes list does not wait for them.
 */

/**
 * A copy of the note's current text, as a new note; returns its ID. Naming
 * the original lets the copy keep its attachments (B1: the server checks the
 * copy may use them, and accepts them while files are off only because the
 * original already has them).
 */
export async function duplicateNote(
  client: ConvexReactClient,
  doc: string,
  notebookId: string | undefined,
  sourceNoteId: string,
): Promise<string> {
  const result = await client.mutation(api.notes.create, {
    clientKey: "copy-" + crypto.randomUUID(),
    doc,
    ...(notebookId ? { notebookId: notebookId as Id<"notebooks"> } : {}),
    sourceNoteId: sourceNoteId as Id<"notes">,
  });
  return result.noteId;
}

/**
 * Pins, sort orders and custom positions are personal (D102). Each write
 * names the account it was made in, so the server refuses it if it arrives
 * under another sign-in, and returns the person's arrangement version after
 * it. Convex sends one client's mutations in the order they were called,
 * including after a reconnect, so this device's writes apply in order.
 */
export async function setPin(
  client: ConvexReactClient,
  account: string,
  noteId: string,
  pinned: boolean,
): Promise<number> {
  return (
    await client.mutation(api.arrangement.setPin, {
      account,
      noteId: noteId as Id<"notes">,
      pinned,
    })
  ).version;
}

export async function setOrder(
  client: ConvexReactClient,
  account: string,
  list: string,
  order: "edited" | "alpha" | "created" | "custom",
): Promise<number> {
  return (
    await client.mutation(api.arrangement.setOrder, { account, list, order })
  ).version;
}

/**
 * Writes positions in batches the server accepts. All batches are sent at
 * once, one after another, so no other write from this device lands between
 * them.
 */
export async function setPositions(
  client: ConvexReactClient,
  account: string,
  notebookId: string,
  entries: { noteId: string; key: string }[],
): Promise<number> {
  const batches: Promise<{ version: number }>[] = [];
  for (let start = 0; start < entries.length; start += 100)
    batches.push(
      client.mutation(api.arrangement.setPositions, {
        account,
        notebookId: notebookId as Id<"notebooks">,
        entries: entries.slice(start, start + 100).map((entry) => ({
          noteId: entry.noteId as Id<"notes">,
          key: entry.key,
        })),
      }),
    );
  const results = await Promise.all(batches);
  return Math.max(...results.map((result) => result.version));
}

export function fileName(title: string, extension: string) {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "Untitled"}.${extension}`;
}

export function downloadMarkdown(title: string, doc: string) {
  const blob = new Blob([docToMarkdown(parseStoredDoc(doc))], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(title, "md");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const printStyle = `
  body { font: 12pt/1.5 Georgia, serif; margin: 2cm; color: #111; }
  h1, h2, h3 { font-family: system-ui, sans-serif; line-height: 1.25; }
  pre { white-space: pre-wrap; font-size: 10pt; }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ccc; }
  ul[data-type="tasks"] { list-style: none; padding-left: 0.25em; }
  li[data-checked]::before { content: "\\2610\\00a0"; }
  li[data-checked="true"]::before { content: "\\2611\\00a0"; }
  li[data-checked] > p { display: inline; }
  img { max-width: 100%; }
`;

/**
 * Print the note through the browser's print sheet, which also saves a PDF.
 * The installed iPhone app cannot print (Deltos found the same), so it
 * reports that instead. The note is rendered with the editor's own schema.
 */
export function printNote(title: string, doc: string): boolean {
  if ((navigator as { standalone?: boolean }).standalone) return false;
  // Validate before adding anything to the page; a bad document throws here.
  const content = parseStoredDoc(doc).content;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0";
  document.body.append(frame);
  try {
    const target = frame.contentWindow;
    if (!target) {
      frame.remove();
      return false;
    }
    const page = target.document;
    page.open();
    page.write(
      "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>",
    );
    page.close();
    page.title = title;
    const style = page.createElement("style");
    style.textContent = printStyle;
    page.head.append(style);
    page.body.append(
      DOMSerializer.fromSchema(notesSchema).serializeFragment(content, {
        document: page,
      }),
    );
    target.addEventListener("afterprint", () => frame.remove());
    setTimeout(() => frame.remove(), 120_000);
    target.focus();
    target.print();
    return true;
  } catch (failure) {
    frame.remove();
    throw failure;
  }
}
