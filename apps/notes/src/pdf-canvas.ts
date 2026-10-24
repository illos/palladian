/**
 * How large a PDF page's canvas is (plan 08 B4, review round 1, F2). Kept
 * apart from pdf-engine.ts, which loads pdf.js, so it can be tested alone.
 */

/** A canvas never holds more than this many pixels (a large page on a dense screen). */
export const MAX_CANVAS_PIXELS = 4_000_000;

/**
 * The scale to draw a page at, in canvas pixels per PDF unit: its display
 * scale times the screen's pixel ratio, so it is sharp on dense screens, but
 * never more than `MAX_CANVAS_PIXELS` pixels in all. `page` is the page's
 * size at scale 1 (PDF units).
 */
export function canvasScale(
  page: { width: number; height: number },
  scale: number,
  pixelRatio: number,
) {
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height));
  return Math.min(scale * Math.max(1, pixelRatio), cap);
}
