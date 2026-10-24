/**
 * In-document search for the PDF reader (plan 08 B4), ported from Deltos
 * `views/pdf/pdfSearch.ts`. Pure string and index work, apart from the
 * React component so it is easy to test.
 *
 * A PDF's text is the file's, not ours: it is only sliced and compared here,
 * never turned into markup. The text layer renders each slice as a React
 * text node, so markup in a PDF stays characters.
 */

/** One run of text on a page, in the page's CSS pixels at scale 1. */
export interface PdfTextItem {
  /** The text, as the file has it. Render as text only. */
  str: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A page's text runs, in reading order as pdf.js gives them. */
export interface PdfPageText {
  items: PdfTextItem[];
}

/** A match: a range of characters in one page's joined text. */
export interface PdfMatch {
  /** 0-based. */
  pageIndex: number;
  charStart: number;
  charEnd: number;
}

/** Part of a run: plain, a match, or the match the reader is on. */
export interface TextSegment {
  text: string;
  kind: "plain" | "match" | "active";
}

/**
 * Lower case, keeping the length, so offsets map back to the original
 * text one to one.
 */
export function normalize(text: string) {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

/** A page's runs joined without separators, and where each run starts. */
export function pagePlainText(items: readonly PdfTextItem[]) {
  let text = "";
  const itemStarts: number[] = [];
  for (const item of items) {
    itemStarts.push(text.length);
    text += item.str;
  }
  return { text, itemStarts };
}

/** Every match of `query` (already normalized) in a page, left to right. */
export function findPageMatches(
  items: readonly PdfTextItem[],
  query: string,
): { charStart: number; charEnd: number }[] {
  if (!query) return [];
  const haystack = normalize(pagePlainText(items).text);
  const found: { charStart: number; charEnd: number }[] = [];
  for (let from = 0; ; ) {
    const at = haystack.indexOf(query, from);
    if (at < 0) break;
    found.push({ charStart: at, charEnd: at + query.length });
    from = at + query.length;
  }
  return found;
}

/**
 * The matches in the pages read so far, in document order. A page not read
 * yet (null) adds none until it is, so results grow while the reader reads.
 */
export function buildMatches(
  pages: ReadonlyArray<PdfPageText | null>,
  rawQuery: string,
): PdfMatch[] {
  const query = normalize(rawQuery.trim());
  if (!query) return [];
  const matches: PdfMatch[] = [];
  pages.forEach((page, pageIndex) => {
    if (!page) return;
    for (const range of findPageMatches(page.items, query))
      matches.push({ pageIndex, ...range });
  });
  return matches;
}

/**
 * One run split into the parts the matches on its page cover. `itemStart`
 * is where the run begins in the page's joined text. Slices only: the
 * caller renders each part as text.
 */
export function splitItemForRender(
  item: PdfTextItem,
  itemStart: number,
  ranges: ReadonlyArray<{ charStart: number; charEnd: number }>,
  active?: { charStart: number; charEnd: number } | null,
): TextSegment[] {
  const text = item.str;
  const itemEnd = itemStart + text.length;
  // 0 plain, 1 a match, 2 the active match.
  const flags = new Uint8Array(text.length);
  const mark = (range: { charStart: number; charEnd: number }, value: 1 | 2) => {
    const from = Math.max(range.charStart, itemStart);
    const to = Math.min(range.charEnd, itemEnd);
    for (let at = from; at < to; at++) flags[at - itemStart] = value;
  };
  for (const range of ranges) mark(range, 1);
  if (active) mark(active, 2);
  const kinds = ["plain", "match", "active"] as const;
  const segments: TextSegment[] = [];
  let start = 0;
  for (let at = 1; at <= text.length; at++)
    if (at === text.length || flags[at] !== flags[at - 1]) {
      segments.push({
        text: text.slice(start, at),
        kind: kinds[flags[start] ?? 0]!,
      });
      start = at;
    }
  return segments;
}
