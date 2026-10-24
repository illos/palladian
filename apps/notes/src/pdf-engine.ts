import {
  getDocument,
  PDFWorker,
  Util,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { canvasScale } from "./pdf-canvas";
import type { PdfPageText, PdfTextItem } from "./pdf-search";

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/**
 * pdf.js for the PDF reader (plan 08 B4), ported from Deltos
 * `views/pdf/pdfEngine.ts`. Only pdf-reader.tsx imports this, and only
 * through a dynamic import, so pdf.js is never in the startup bundle or the
 * editor's.
 *
 * The file is parsed, never run:
 * - no scripting: the scripting sandbox (`pdf.sandbox`) is never loaded and
 *   no annotation layer is drawn, so a PDF's JavaScript and form actions
 *   never run;
 * - no XFA (`enableXfa: false`), and no eval: this pdf.js (6.4) has no
 *   `eval` or `Function` code path at all, and `isEvalSupported: false`
 *   is passed as well, as the brief asks, in case a later version has one;
 * - no network: the bytes are handed over whole (they came through the
 *   app's authenticated read), with streaming and range requests off. Only
 *   pdf.js's own font, CMap and decoder files are fetched, from this app's
 *   origin (vite.config.ts copies them to /pdfjs/).
 * - a worker of our own: the bundled worker file, same origin, as a module
 *   worker; pdf.js never fetches a worker from elsewhere. pdf.js does not end
 *   a worker it was handed, so this module terminates it itself whenever the
 *   document goes: closed, failed, or abandoned while opening (review round
 *   1, F1).
 */

/** A page's size in CSS pixels at scale 1. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** A render of one page into one canvas, which a scroll may cancel. */
export interface PdfRender {
  readonly done: Promise<void>;
  cancel(): void;
}

/** Visible pages before thumbnails, thumbnails before reading text for search. */
export const PRIORITY = { page: 0, thumbnail: 1, text: 2 } as const;
type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/** An open document. */
export interface OpenedPdf {
  readonly pages: number;
  /** Reads the page's size; draws nothing. */
  pageSize(page: number): Promise<PdfPageSize>;
  /** Draws `page` into `canvas` at `scale` (CSS pixels per PDF unit). */
  render(
    page: number,
    canvas: HTMLCanvasElement,
    scale: number,
    priority?: Priority,
  ): PdfRender;
  /** The page's text runs, for selection and search. */
  text(page: number): Promise<PdfPageText>;
  /** Stops everything, frees the document and ends the worker. */
  destroy(): void;
}

/** Renders and text reads at a time. */
const PARALLEL = 2;
/** pdf.js's data files, from this origin (vite.config.ts). */
const ASSETS = "/pdfjs/";

/** A page's text runs, placed in its scale-1 box. */
function placeText(content: TextContent, transform: number[]): PdfPageText {
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    // Marked-content entries carry no text.
    if (!("str" in item) || !item.str) continue;
    const at: number[] = Util.transform(transform, item.transform);
    const height = Math.hypot(at[2] ?? 0, at[3] ?? 0) || item.height;
    items.push({
      str: item.str,
      left: at[4] ?? 0,
      // pdf.js gives the baseline; the run's box starts one height above.
      top: (at[5] ?? 0) - height,
      width: item.width,
      height,
    });
  }
  return { items };
}

const closed = () => new DOMException("The reader closed.", "AbortError");

/** `promise`, or an AbortError as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(closed());
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Open a PDF from its bytes. pdf.js takes over (detaches) the buffer it is
 * given, so it gets its own copy: the cached bytes stay whole for the next
 * opening (Deltos's reopen bug).
 *
 * Aborting `signal` while it opens ends everything it started at once (the
 * worker is terminated) and rejects with an AbortError; so does a failure
 * (a damaged or encrypted file). Once open, `destroy` ends it.
 */
export async function openPdf(
  bytes: Blob,
  signal: AbortSignal,
): Promise<OpenedPdf> {
  const data = new Uint8Array(await untilAborted(bytes.arrayBuffer(), signal));
  if (signal.aborted) throw closed();
  const port = new Worker(workerUrl, { type: "module" });
  const worker = PDFWorker.create({ port });
  const parameters = {
    data,
    worker,
    enableXfa: false,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    cMapUrl: ASSETS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: ASSETS + "standard_fonts/",
    wasmUrl: ASSETS + "wasm/",
    iccUrl: ASSETS + "iccs/",
    stopAtErrors: false,
  };
  const loading = getDocument(parameters);
  let ended = false;
  /** The document, its loading and its worker, gone for good. */
  const end = () => {
    if (ended) return;
    ended = true;
    void loading.destroy().catch(() => undefined);
    worker.destroy();
    port.terminate();
  };
  let doc: PDFDocumentProxy;
  try {
    doc = await untilAborted(loading.promise, signal);
  } catch (error) {
    // Failed (a damaged or encrypted file), or abandoned while opening.
    end();
    throw error;
  }

  // One queue for every render and text read: the most urgent job takes
  // the next free slot, so thumbnails and search never hold up the page
  // being read.
  const queue: { run: () => void; priority: number; order: number }[] = [];
  let order = 0;
  let active = 0;
  let destroyed = false;
  const pump = () => {
    while (active < PARALLEL && queue.length) {
      let best = 0;
      for (let index = 1; index < queue.length; index++) {
        const job = queue[index]!;
        const chosen = queue[best]!;
        if (
          job.priority < chosen.priority ||
          (job.priority === chosen.priority && job.order < chosen.order)
        )
          best = index;
      }
      const [job] = queue.splice(best, 1);
      active++;
      job!.run();
    }
  };
  /** Run `work` when a slot is free; the slot is free again once it settles. */
  const schedule = <T>(priority: number, work: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        priority,
        order: order++,
        run: () => {
          const settle = () => {
            active--;
            pump();
          };
          if (destroyed) {
            settle();
            reject(new Error("The document was closed."));
            return;
          }
          work().then(
            (value) => {
              settle();
              resolve(value);
            },
            (error: unknown) => {
              settle();
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        },
      });
      pump();
    });

  return {
    pages: doc.numPages,
    async pageSize(page) {
      const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    },
    render(page, canvas, scale, priority = PRIORITY.page) {
      let cancelled = false;
      let task: RenderTask | null = null;
      const done = schedule(priority, async () => {
        if (cancelled) throw new Error("Render cancelled.");
        const proxy = await doc.getPage(page);
        if (cancelled || destroyed) throw new Error("Render cancelled.");
        // Sharp on dense screens, within the pixel cap (F2).
        const css = proxy.getViewport({ scale });
        const viewport = proxy.getViewport({
          scale: canvasScale(
            proxy.getViewport({ scale: 1 }),
            scale,
            window.devicePixelRatio || 1,
          ),
        });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(css.width)}px`;
        canvas.style.height = `${Math.floor(css.height)}px`;
        task = proxy.render({ canvas, viewport });
        await task.promise;
      });
      return {
        done,
        cancel() {
          cancelled = true;
          task?.cancel();
        },
      };
    },
    text(page) {
      return schedule(PRIORITY.text, async () => {
        const proxy = await doc.getPage(page);
        const viewport = proxy.getViewport({ scale: 1 });
        return placeText(await proxy.getTextContent(), viewport.transform);
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      queue.length = 0;
      end();
    },
  };
}
