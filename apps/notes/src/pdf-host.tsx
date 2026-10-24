import { createRoot, type Root } from "react-dom/client";
import { AttachmentReadError } from "./attachments";
import type { FileInfo, FileOpening } from "./editor-attachments";
import type { PdfReaderProps } from "./pdf-reader";

/**
 * Where the PDF reader shows (plan 08 B4): inline in a file note
 * (`mountPdfReader`, from its node view) and full screen
 * (`openPdfDialog`, the opener editor.tsx registers for PDFs, used by a PDF
 * chip and by a file note's Full screen).
 *
 * The reader and pdf.js load on first use (`import()`), never with the
 * editor. Whoever mounts the reader removes it when its bytes may no longer
 * show; removal takes it off the page synchronously, and React and pdf.js
 * finish tearing it down right after.
 */

let readerModule: Promise<typeof import("./pdf-reader")> | null = null;
const loadReader = () => (readerModule ??= import("./pdf-reader"));

/** Plain "could not open" with Download, when even the reader cannot load. */
function fallback(host: HTMLElement, onDownload: () => void) {
  const box = document.createElement("div");
  box.className = "pdf-reader pdf-reader-error";
  const text = document.createElement("p");
  text.textContent = "This PDF could not be opened here.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-download";
  button.textContent = "Download to view";
  button.addEventListener("click", onDownload);
  box.append(text, button);
  host.append(box);
  return box;
}

/**
 * Show the reader for these bytes in `host`. Returns the function that
 * removes it: at once from the page, then React and the document.
 */
export function mountPdfReader(
  host: HTMLElement,
  props: PdfReaderProps,
): () => void {
  const box = document.createElement("div");
  box.className = "pdf-reader-box";
  host.append(box);
  let root: Root | null = null;
  let removed = false;
  loadReader().then(
    ({ PdfReader }) => {
      if (removed) return;
      root = createRoot(box);
      root.render(<PdfReader {...props} />);
    },
    () => {
      if (!removed) fallback(box, props.onDownload);
    },
  );
  return () => {
    if (removed) return;
    removed = true;
    box.remove();
    const mounted = root;
    root = null;
    // Not while React may be rendering (a clear can come from anywhere).
    if (mounted) queueMicrotask(() => mounted.unmount());
  };
}

/** The full-screen reader on the page, if any; one at a time. */
let shown: { close: () => void } | null = null;

/**
 * Open a PDF full screen (the opener for `application/pdf`). It closes
 * itself, at once, when `opening.signal` aborts: the editor closed, the
 * session moved on, files turned off, the byte cache was cleared or the
 * object became unavailable (FileOpening).
 */
export function openPdfDialog(file: FileInfo, opening: FileOpening) {
  shown?.close();
  const dialog = document.createElement("dialog");
  dialog.className = "pdf-dialog";
  dialog.setAttribute("aria-label", `PDF: ${file.name}`);
  const header = document.createElement("header");
  header.className = "pdf-dialog-header";
  const title = document.createElement("h2");
  title.textContent = file.name;
  const download = document.createElement("button");
  download.type = "button";
  download.className = "pdf-dialog-action";
  download.textContent = "Download";
  download.setAttribute("aria-label", `Download ${file.name}`);
  download.addEventListener("click", () => opening.download());
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "pdf-dialog-close";
  closeButton.setAttribute("aria-label", "Close PDF");
  closeButton.textContent = "×";
  header.append(title, download, closeButton);
  const body = document.createElement("div");
  body.className = "pdf-dialog-body";
  const status = document.createElement("p");
  status.className = "pdf-status";
  status.setAttribute("role", "status");
  status.textContent = "Opening…";
  body.append(status);
  dialog.append(header, body);

  let removeReader: (() => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (shown === entry) shown = null;
    opening.signal.removeEventListener("abort", close);
    removeReader?.();
    removeReader = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    opening.release();
  };
  const entry = { close };
  shown = entry;
  opening.signal.addEventListener("abort", close, { once: true });
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  if (opening.signal.aborted) return close();
  document.body.append(dialog);
  dialog.showModal();
  opening.bytes().then(
    (data) => {
      if (closed) return;
      status.remove();
      removeReader = mountPdfReader(body, {
        name: file.name,
        data,
        onDownload: () => opening.download(),
      });
    },
    (error: unknown) => {
      if (closed) return;
      const kind =
        error instanceof AttachmentReadError ? error.kind : "failed";
      status.textContent =
        kind === "signed-out"
          ? "Not available offline."
          : kind === "unavailable"
            ? "This attachment is unavailable."
            : "The PDF could not load.";
    },
  );
}
