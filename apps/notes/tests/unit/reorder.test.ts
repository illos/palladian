import { describe, expect, test } from "vitest";
import { arrangeRows } from "../../src/arrange";
import type { NoteSummary } from "../../src/cache";
import { dropIndex, placement, type Positioned } from "../../src/reorder";

/** Apply writes and return the custom order they produce. */
function orderAfter(
  others: Positioned[],
  moved: Positioned,
  writes: { noteId: string; key: string }[],
) {
  const keys = new Map([...others, moved].map((row) => [row.id, row.key]));
  for (const write of writes) keys.set(write.noteId, write.key);
  const rows: NoteSummary[] = [...others, moved].map((row, i) => ({
    accountId: "a",
    id: row.id,
    title: row.id,
    preview: "",
    updatedAt: 100 - i,
    kind: "cached",
  }));
  return arrangeRows(
    rows,
    {
      pins: [],
      orders: [{ list: "nb", order: "custom" }],
      positions: [...keys]
        .filter(([, key]) => key !== undefined)
        .map(([noteId, key]) => ({ notebookId: "nb", noteId, key: key! })),
    },
    "nb",
    { pins: true },
  ).map((row) => row.id);
}

describe("reorder", () => {
  test("drop index counts the middles above the pointer", () => {
    expect(dropIndex([10, 30, 50], 5)).toBe(0);
    expect(dropIndex([10, 30, 50], 31)).toBe(2);
    expect(dropIndex([10, 30, 50], 99)).toBe(3);
  });

  test("the first drag in a notebook spaces out every note", () => {
    const others = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const writes = placement(others, 1, "x");
    expect(writes).toHaveLength(4);
    expect(orderAfter(others, { id: "x" }, writes)).toEqual([
      "a",
      "x",
      "b",
      "c",
    ]);
  });

  test("between positioned neighbours, one key is written", () => {
    const others = [
      { id: "a", key: "F" },
      { id: "b", key: "V" },
      { id: "c", key: "k" },
    ];
    const writes = placement(others, 2, "x");
    expect(writes).toEqual([{ noteId: "x", key: expect.any(String) }]);
    expect(orderAfter(others, { id: "x", key: "z" }, writes)).toEqual([
      "a",
      "b",
      "x",
      "c",
    ]);
    expect(
      orderAfter(others, { id: "x", key: "z" }, placement(others, 0, "x")),
    ).toEqual(["x", "a", "b", "c"]);
    expect(
      orderAfter(others, { id: "x", key: "0z" }, placement(others, 3, "x")),
    ).toEqual(["a", "b", "c", "x"]);
  });

  test("new notes at the top get keys ahead of the first positioned one", () => {
    const others = [
      { id: "new1" },
      { id: "new2" },
      { id: "a", key: "F" },
      { id: "b", key: "V" },
    ];
    const writes = placement(others, 3, "x");
    expect(writes.map((w) => w.noteId)).toEqual(["new1", "new2", "x"]);
    expect(orderAfter(others, { id: "x", key: "z" }, writes)).toEqual([
      "new1",
      "new2",
      "a",
      "x",
      "b",
    ]);
  });

  test("equal or out-of-order keys respace instead of failing", () => {
    // Two devices placed notes at once, or a note kept its key while pinned.
    const others = [
      { id: "a", key: "V" },
      { id: "b", key: "V" },
      { id: "c", key: "k" },
    ];
    const writes = placement(others, 1, "x");
    expect(writes).toHaveLength(4);
    expect(orderAfter(others, { id: "x" }, writes)).toEqual([
      "a",
      "x",
      "b",
      "c",
    ]);
    const unsorted = [
      { id: "a", key: "k" },
      { id: "b", key: "V" },
    ];
    expect(placement(unsorted, 2, "x")).toHaveLength(3);
    // A note without a key below positioned ones cannot be placed between.
    const gap = [{ id: "a", key: "V" }, { id: "b" }, { id: "c", key: "k" }];
    expect(placement(gap, 3, "x")).toHaveLength(4);
  });

  test("keys that would grow too long respace the notebook", () => {
    let others: Positioned[] = [
      { id: "a", key: "V" },
      { id: "b", key: "W" },
    ];
    // Keep dropping right after "a": keys between "V" and the last one grow.
    for (let i = 0; i < 400; i++) {
      const writes = placement(others, 1, "n" + i);
      const keys = new Map(others.map((row) => [row.id, row.key]));
      for (const w of writes) keys.set(w.noteId, w.key);
      others = [...keys].map(([id, key]) => ({ id, key }));
      others.sort((x, y) => (x.key! < y.key! ? -1 : x.key! > y.key! ? 1 : 0));
      for (const row of others) expect(row.key!.length).toBeLessThanOrEqual(48);
    }
    expect(others[0]!.id).toBe("a");
    expect(others.at(-1)!.id).toBe("b");
  });
});
