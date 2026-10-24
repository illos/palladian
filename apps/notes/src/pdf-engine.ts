import {
  getDocument,
  PDFWorker,
  Util,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
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
 *   worker; pdf.js never fetches a worker from elsewhere.
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

/** A canvas never holds more than this many pixels (a large page on a dense screen). */
const MAX_CANVAS_PIXELS = 4_000_000;
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

/**
 * Open a PDF from its bytes. pdf.js takes over (detaches) the buffer it is
 * given, so it gets its own copy: the cached bytes stay whole for the next
 * opening (Deltos's reopen bug).
 */
export async function openPdf(bytes: Blob): Promise<OpenedPdf> {
  const data = new Uint8Array(await bytes.arrayBuffer());
  const worker = PDFWorker.create({
    port: new Worker(workerUrl, { type: "module" }),
  });
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
  let doc: PDFDocumentProxy;
  try {
    doc = await loading.promise;
  } catch (error) {
    worker.destroy();
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
        // Sharp on dense screens, within the pixel cap.
        const css = proxy.getViewport({ scale });
        const cap = Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height));
        const viewport = proxy.getViewport({
          scale: Math.min(scale * (window.devicePixelRatio || 1), cap),
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
      void loading.destroy().catch(() => undefined);
      worker.destroy();
    },
  };
}
