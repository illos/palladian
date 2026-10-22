/**
 * A diff of two plain texts for the History view (plan 08, A4), after Deltos's
 * `lib/textDiff.ts`: words and the spaces between them are compared with a
 * longest common subsequence, which reads better than single characters for
 * prose. Deltos cut both texts at 2,000 words, silently dropping the rest; here
 * the work is bounded instead. The common start and end are matched first, in
 * linear time, so a typical edit compares only the changed region. When that
 * region is too large to compare word by word it is compared line by line,
 * and when even that is too large it is shown as removed and added whole.
 * Every result reproduces both texts exactly.
 */

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffPart {
  op: DiffOp;
  text: string;
}

export interface TextDiff {
  /** In reading order; neighbouring parts never share an operation. */
  parts: DiffPart[];
  /** How finely the changed region was compared. */
  detail: "word" | "line" | "block";
}

/**
 * The largest comparison table, in cells (changed tokens before × after), that
 * a diff may build: a few milliseconds and a few megabytes on a phone.
 */
export const DIFF_CELL_LIMIT = 2_500_000;

function words(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

class Parts {
  readonly list: DiffPart[] = [];
  push(op: DiffOp, text: string) {
    if (!text) return;
    const last = this.list[this.list.length - 1];
    if (last?.op === op) last.text += text;
    else this.list.push({ op, text });
  }
}

/** Where two token lists stop agreeing, from the start and from the end. */
function commonEnds(a: string[], b: string[]) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

/** Compare token lists into `parts`; false if the changed region is too large. */
function diffTokens(
  a: string[],
  b: string[],
  limit: number,
  parts: Parts,
): boolean {
  const { start, endA, endB } = commonEnds(a, b);
  const m = endA - start;
  const n = endB - start;
  if ((m + 1) * (n + 1) > limit) return false;
  parts.push("equal", a.slice(0, start).join(""));
  // lcs[i * (n + 1) + j]: the longest common subsequence of a[start + i..endA]
  // and b[start + j..endB]. Filled from the end so the walk below runs forward.
  const width = n + 1;
  const lcs =
    Math.min(m, n) < 0xffff
      ? new Uint16Array((m + 1) * width)
      : new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[start + i] === b[start + j]) {
      parts.push("equal", a[start + i]!);
      i++;
      j++;
    } else if (
      i < m &&
      (j === n || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)
    ) {
      // Removals come before additions in a replaced run, as in Deltos.
      parts.push("delete", a[start + i]!);
      i++;
    } else {
      parts.push("insert", b[start + j]!);
      j++;
    }
  }
  parts.push("equal", a.slice(endA).join(""));
  return true;
}

/**
 * How `before` became `after`: `insert` is only in `after`, `delete` only in
 * `before`, and `equal` in both.
 */
export function diffText(
  before: string,
  after: string,
  limit = DIFF_CELL_LIMIT,
): TextDiff {
  if (before === after)
    return {
      parts: before ? [{ op: "equal", text: before }] : [],
      detail: "word",
    };
  let parts = new Parts();
  if (diffTokens(words(before), words(after), limit, parts))
    return { parts: parts.list, detail: "word" };
  parts = new Parts();
  if (diffTokens(lines(before), lines(after), limit, parts))
    return { parts: parts.list, detail: "line" };
  // Too different to compare in detail: keep the common start and end, and
  // show everything between as removed and added.
  const a = lines(before);
  const b = lines(after);
  const { start, endA, endB } = commonEnds(a, b);
  parts = new Parts();
  parts.push("equal", a.slice(0, start).join(""));
  parts.push("delete", a.slice(start, endA).join(""));
  parts.push("insert", b.slice(start, endB).join(""));
  parts.push("equal", a.slice(endA).join(""));
  return { parts: parts.list, detail: "block" };
}

/** Whether the diff found any change. */
export function changed(diff: TextDiff): boolean {
  return diff.parts.some((part) => part.op !== "equal");
}
