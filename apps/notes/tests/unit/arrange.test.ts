import { describe, expect, test } from "vitest";
import { arrangeRows, keyBetween, spacedKeys } from "../../src/arrange";
import type { Arrangement, NoteSummary } from "../../src/cache";

const row = (
  id: string,
  title: string,
  updatedAt: number,
  createdAt?: number,
): NoteSummary => ({
  accountId: "a",
  id,
  title,
  preview: "",
  updatedAt,
  kind: "cached",
  notebookId: "nb",
  ...(createdAt !== undefined ? { createdAt } : {}),
});

const rows = [
  row("1", "banana", 30, 1),
  row("2", "Apple", 10, 3),
  row("3", "cherry", 20, 2),
];
const ids = (list: NoteSummary[]) => list.map((r) => r.id);
const arrangement = (over: Partial<Arrangement> = {}): Arrangement => ({
  pins: [],
  orders: [],
  positions: [],
  ...over,
});

describe("list order", () => {
  test("defaults to last edited", () => {
    expect(ids(arrangeRows(rows, null, "all", { pins: true }))).toEqual([
      "1",
      "3",
      "2",
    ]);
  });

  test("alphabetical ignores case; date created falls back to last edited", () => {
    const alpha = arrangement({ orders: [{ list: "all", order: "alpha" }] });
    expect(ids(arrangeRows(rows, alpha, "all", { pins: true }))).toEqual([
      "2",
      "1",
      "3",
    ]);
    const created = arrangement({ orders: [{ list: "nb", order: "created" }] });
    expect(ids(arrangeRows(rows, created, "nb", { pins: true }))).toEqual([
      "2",
      "3",
      "1",
    ]);
    const old = [row("4", "old", 50), ...rows];
    expect(ids(arrangeRows(old, created, "nb", { pins: true }))[0]).toBe("4");
  });

  test("pins come first, newest pin on top, then the list's order", () => {
    const pinned = arrangement({
      pins: [
        { noteId: "2", pinnedAt: 100 },
        { noteId: "3", pinnedAt: 200 },
      ],
    });
    expect(ids(arrangeRows(rows, pinned, "all", { pins: true }))).toEqual([
      "3",
      "2",
      "1",
    ]);
    // Trash ignores pins.
    expect(ids(arrangeRows(rows, pinned, "trash", { pins: false }))).toEqual([
      "1",
      "3",
      "2",
    ]);
  });

  test("custom order: positioned notes by key, notes without one first", () => {
    const custom = arrangement({
      orders: [{ list: "nb", order: "custom" }],
      positions: [
        { notebookId: "nb", noteId: "1", key: "k" },
        { notebookId: "nb", noteId: "2", key: "V" },
        // Positions in other notebooks do not apply here.
        { notebookId: "other", noteId: "3", key: "0" },
      ],
    });
    expect(ids(arrangeRows(rows, custom, "nb", { pins: true }))).toEqual([
      "3",
      "2",
      "1",
    ]);
  });
});

describe("position keys", () => {
  test("keyBetween always fits between its neighbours", () => {
    let low = keyBetween(null, null);
    let high = keyBetween(low, null);
    expect(low < high).toBe(true);
    // Repeatedly insert just after `low`: keys stay ordered and short enough.
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      expect(mid.endsWith("0")).toBe(false);
      high = mid;
    }
    expect(high.length).toBeLessThan(48);
    const first = keyBetween(null, low);
    expect(first < low).toBe(true);
    void low;
    low = first;
  });

  test("spaced keys are strictly increasing, short and leave room", () => {
    for (const count of [1, 2, 10, 61, 62, 500]) {
      const keys = spacedKeys(count);
      expect(keys).toHaveLength(count);
      for (let i = 1; i < keys.length; i++)
        expect(keys[i - 1]! < keys[i]!).toBe(true);
      for (const key of keys) {
        expect(key).toMatch(/^[0-9A-Za-z]{1,4}$/);
        expect(key.endsWith("0")).toBe(false);
      }
      expect(keyBetween(keys[0]!, keys[1] ?? null) > keys[0]!).toBe(true);
    }
  });
});
