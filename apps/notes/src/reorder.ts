import { KEY_LIMIT, keyBetween, spacedKeys } from "./arrange";

/**
 * Custom order by dragging (D102). A drop writes one position key when its
 * neighbours have keys. Notes without one (new, or moved in) sit at the top;
 * they get keys first, ahead of the first positioned note. If keys would grow
 * too long, the whole notebook is spaced out again.
 */

/** Where a dragged row lands: how many of the other rows' middles are above y. */
export function dropIndex(middles: number[], y: number): number {
  let index = 0;
  while (index < middles.length && middles[index]! < y) index++;
  return index;
}

export interface Positioned {
  id: string;
  key?: string | undefined;
}

/**
 * The keys to write when `moved` is dropped at `index` among `others` (the
 * list in its current order, without the moved note).
 */
export function placement(
  others: Positioned[],
  index: number,
  moved: string,
): { noteId: string; key: string }[] {
  const order = [
    ...others.slice(0, index).map((row) => row.id),
    moved,
    ...others.slice(index).map((row) => row.id),
  ];
  const respace = () =>
    spacedKeys(order.length).map((key, i) => ({ noteId: order[i]!, key }));
  const keyed = others.filter((row) => row.key !== undefined);
  if (!keyed.length) return respace();
  // Notes without a key form the top of the list: give them keys ahead of
  // the first positioned note, in their current order.
  const writes: { noteId: string; key: string }[] = [];
  const keys = new Map(others.map((row) => [row.id, row.key]));
  const firstKeyed = keyed[0]!.key!;
  let previous: string | null = null;
  for (const row of others) {
    if (row.key !== undefined) break;
    const key = keyBetween(previous, firstKeyed);
    keys.set(row.id, key);
    writes.push({ noteId: row.id, key });
    previous = key;
  }
  const before = index > 0 ? keys.get(others[index - 1]!.id)! : null;
  const after = index < others.length ? keys.get(others[index]!.id)! : null;
  const key = keyBetween(before, after);
  if (
    key.length > KEY_LIMIT ||
    writes.some((write) => write.key.length > KEY_LIMIT)
  )
    return respace();
  writes.push({ noteId: moved, key });
  return writes;
}
