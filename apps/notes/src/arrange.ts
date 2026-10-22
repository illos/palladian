import type { Arrangement, NoteSummary } from "./cache";

/**
 * Ordering of note lists (D102): pinned notes first, newest pin on top, then
 * the list's own order: last edited (the default), alphabetical, date created,
 * or the person's custom order. Pure functions over cached rows.
 */

export type ListOrder = Arrangement["orders"][number]["order"];

/** "all" for All Notes, or a notebook ID; Trash keeps last-edited order. */
export function orderOf(
  arrangement: Arrangement | null,
  list: string,
): ListOrder {
  return arrangement?.orders.find((o) => o.list === list)?.order ?? "edited";
}

const byEdited = (a: NoteSummary, b: NoteSummary) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

const titleOf = (row: NoteSummary) => row.title.trim() || "Untitled";

// One collator: localeCompare with options builds one per call, which made
// sorting 2,000 notes take tens of milliseconds.
const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export function arrangeRows(
  rows: NoteSummary[],
  arrangement: Arrangement | null,
  list: string,
  options: { pins: boolean },
): NoteSummary[] {
  const order = orderOf(arrangement, list);
  const keys = new Map(
    (arrangement?.positions ?? [])
      .filter((p) => p.notebookId === list)
      .map((p) => [p.noteId, p.key]),
  );
  const compare = (a: NoteSummary, b: NoteSummary): number => {
    switch (order) {
      case "alpha":
        return collator.compare(titleOf(a), titleOf(b)) || byEdited(a, b);
      case "created":
        return (
          (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt) ||
          byEdited(a, b)
        );
      case "custom": {
        // Notes without a position yet (new or moved in) come first.
        const ka = keys.get(a.id);
        const kb = keys.get(b.id);
        if (ka === undefined || kb === undefined)
          return ka === kb ? byEdited(a, b) : ka === undefined ? -1 : 1;
        return ka < kb ? -1 : ka > kb ? 1 : byEdited(a, b);
      }
      default:
        return byEdited(a, b);
    }
  };
  const pinned = new Map(
    options.pins
      ? (arrangement?.pins ?? []).map((p) => [p.noteId, p.pinnedAt])
      : [],
  );
  return [...rows].sort((a, b) => {
    const pa = pinned.get(a.id);
    const pb = pinned.get(b.id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      if (pa !== pb) return pb - pa;
    }
    return compare(a, b);
  });
}

/* ---- Changes not yet confirmed by the server ---- */

/**
 * A change the person made that the server has not confirmed yet. It is shown
 * over the synced arrangement, never written to the device cache, so a failed
 * write leaves nothing behind.
 */
export interface ArrangementEdit {
  apply(current: Arrangement): Arrangement;
  /** Whether a synced arrangement already includes this change. */
  shownIn(current: Arrangement): boolean;
  /** What it changes: a later change to the same thing replaces it. */
  keys: string[];
}

export function pinEdit(
  noteId: string,
  pinned: boolean,
  pinnedAt: number,
): ArrangementEdit {
  return {
    apply: (current) => ({
      ...current,
      pins: [
        ...current.pins.filter((pin) => pin.noteId !== noteId),
        ...(pinned ? [{ noteId, pinnedAt }] : []),
      ],
    }),
    shownIn: (current) =>
      current.pins.some((pin) => pin.noteId === noteId) === pinned,
    keys: ["pin:" + noteId],
  };
}

export function orderEdit(list: string, order: ListOrder): ArrangementEdit {
  return {
    apply: (current) => ({
      ...current,
      orders: [
        ...current.orders.filter((o) => o.list !== list),
        { list, order },
      ],
    }),
    shownIn: (current) => orderOf(current, list) === order,
    keys: ["order:" + list],
  };
}

export function positionsEdit(
  notebookId: string,
  writes: { noteId: string; key: string }[],
): ArrangementEdit {
  const changed = new Set(writes.map((w) => w.noteId));
  return {
    apply: (current) => ({
      ...current,
      positions: [
        ...current.positions.filter((p) => !changed.has(p.noteId)),
        ...writes.map((w) => ({ notebookId, ...w })),
      ],
    }),
    shownIn: (current) =>
      writes.every((w) =>
        current.positions.some(
          (p) =>
            p.noteId === w.noteId &&
            p.notebookId === notebookId &&
            p.key === w.key,
        ),
      ),
    keys: writes.map((w) => "position:" + w.noteId),
  };
}

export interface PendingEdit {
  id: number;
  accountId: string;
  edit: ArrangementEdit;
  /** The server accepted it; it waits for a synced copy that includes it. */
  confirmed: boolean;
}

/**
 * Remove confirmed changes that a synced arrangement includes, and the older
 * changes to the same things they replaced: the server applies one device's
 * writes in order, so those are settled too.
 */
export function settleEdits(
  pending: PendingEdit[],
  synced: Arrangement | null,
): PendingEdit[] {
  if (!synced) return pending;
  const settled = pending.filter((p) => p.confirmed && p.edit.shownIn(synced));
  if (!settled.length) return pending;
  return pending.filter(
    (p) =>
      !settled.some(
        (done) =>
          done.id === p.id ||
          (p.id < done.id &&
            p.edit.keys.some((k) => done.edit.keys.includes(k))),
      ),
  );
}

/** The synced arrangement with the unconfirmed changes on top, in order. */
export function withEdits(
  saved: Arrangement | null,
  edits: ArrangementEdit[],
): Arrangement | null {
  if (!edits.length) return saved;
  return edits.reduce(
    (current, edit) => edit.apply(current),
    saved ?? { pins: [], orders: [], positions: [] },
  );
}

/* ---- Fractional position keys (after rocicorp/fractional-indexing) ---- */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key strictly between `a` and `b`; "" and null mean the open ends. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error("Positions out of order.");
  if (a.endsWith("0") || (b !== null && b.endsWith("0")))
    throw new Error("Positions must not end in 0.");
  if (b) {
    let shared = 0;
    while ((a[shared] ?? "0") === b[shared]) shared++;
    if (shared > 0)
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }
  const low = a ? DIGITS.indexOf(a[0]!) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
}

/** A key that sorts between two neighbours (null at either end of the list). */
export function keyBetween(
  before: string | null,
  after: string | null,
): string {
  return midpoint(before ?? "", after);
}

/** `count` evenly spaced keys, for arranging a whole notebook the first time. */
export function spacedKeys(count: number): string[] {
  let width = 1;
  while (DIGITS.length ** width <= count * 2) width++;
  const span = DIGITS.length ** width;
  const keys: string[] = [];
  for (let i = 1; i <= count; i++) {
    let value = Math.floor((i * span) / (count + 1));
    let key = "";
    for (let d = 0; d < width; d++) {
      key = DIGITS[value % DIGITS.length] + key;
      value = Math.floor(value / DIGITS.length);
    }
    // Keys never end in 0, so another key always fits after them.
    key = key.replace(/0+$/, "");
    if (!key || (keys.length && key <= keys[keys.length - 1]!))
      key = keyBetween(keys[keys.length - 1] ?? null, null);
    keys.push(key);
  }
  return keys;
}

/** Keys longer than this are re-spaced across the whole notebook instead. */
export const KEY_LIMIT = 48;
