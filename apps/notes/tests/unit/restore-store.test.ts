import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import type { PendingRestore } from "../../src/restore-keeper";
import {
  openRecordStore,
  RESTORE_DB,
  type RecordStore,
} from "../../src/restore-store";

// Review round 4 (R4-1, R4-2): the restore records' storage. Each test gets a
// fresh IndexedDB (one "origin"); each `openRecordStore` on it is one window's
// connection.

const record = (requestId: string, over: Partial<PendingRestore> = {}) => ({
  accountId: "account-a",
  noteId: "note-1",
  revision: 3,
  expectedRevision: 10,
  requestId,
  versionEndedAt: 1_000,
  since: 2_000,
  ...over,
});

function windows(count: number) {
  const factory = new IDBFactory();
  return {
    factory,
    stores: Array.from({ length: count }, () => openRecordStore(factory)!),
  };
}

const ids = async (store: RecordStore | null | undefined) =>
  (await store!.list()).records.map((r) => r.requestId).sort();

describe("restore record store", () => {
  test("adds a record durably and reads it back", async () => {
    const {
      stores: [store],
    } = windows(1);
    expect(await store!.add(record("r1"), 20)).toBe("added");
    expect(await store!.list()).toEqual({
      records: [record("r1")],
      corrupt: [],
    });
    // The same request ID twice is refused, not overwritten.
    await expect(
      store!.add(record("r1", { noteId: "other" }), 20),
    ).rejects.toBeTruthy();
    expect((await store!.list()).records).toEqual([record("r1")]);
  });

  test("refuses records past the limit instead of evicting any", async () => {
    const {
      stores: [store],
    } = windows(1);
    for (let i = 0; i < 3; i++)
      expect(await store!.add(record(`r${i}`), 3)).toBe("added");
    expect(await store!.add(record("r3"), 3)).toBe("full");
    expect(await ids(store)).toEqual(["r0", "r1", "r2"]);
  });

  test("overlapping inserts from two windows both persist", async () => {
    const {
      stores: [one, two],
    } = windows(2);
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => one!.add(record(`one-${i}`), 50)),
      ...Array.from({ length: 8 }, (_, i) => two!.add(record(`two-${i}`), 50)),
    ]);
    const all = [
      ...Array.from({ length: 8 }, (_, i) => `one-${i}`),
      ...Array.from({ length: 8 }, (_, i) => `two-${i}`),
    ].sort();
    expect(await ids(one)).toEqual(all);
    expect(await ids(two)).toEqual(all);
  });

  test("an insert in one window and a completion in another both persist", async () => {
    const {
      stores: [one, two],
    } = windows(2);
    await one!.add(record("done"), 20);
    await one!.add(record("applied"), 20);
    await Promise.all([
      two!.add(record("new"), 20),
      one!.remove(["done"]),
      one!.markApplied("applied", 12, 5_000),
      two!.add(record("newer"), 20),
    ]);
    const { records } = await two!.list();
    expect(records.map((r) => r.requestId).sort()).toEqual([
      "applied",
      "new",
      "newer",
    ]);
    expect(records.find((r) => r.requestId === "applied")).toEqual(
      record("applied", { appliedRevision: 12, appliedAt: 5_000 }),
    );
  });

  test("marking a removed record applied does not bring it back", async () => {
    const {
      stores: [one, two],
    } = windows(2);
    await one!.add(record("gone"), 20);
    await two!.remove(["gone"]);
    await one!.markApplied("gone", 12, 5_000);
    expect(await ids(one)).toEqual([]);
  });

  test("entries that do not read as records are reported, not dropped", async () => {
    const { factory, stores } = windows(1);
    const store = stores[0]!;
    await store.add(record("good"), 20);
    // Write damaged entries straight into the database, as corruption would.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(RESTORE_DB, 1);
      open.onsuccess = () => {
        const tx = open.result.transaction("restores", "readwrite");
        const restores = tx.objectStore("restores");
        restores.put({ ...record("x"), revision: "3" }, "bad-a");
        restores.put({ junk: true }, "bad-b");
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const listed = await store.list();
    expect(listed.records.map((r) => r.requestId)).toEqual(["good"]);
    expect(listed.corrupt).toEqual([
      { key: "bad-a", accountId: "account-a" },
      { key: "bad-b", accountId: null },
    ]);
    await store.remove(["bad-a", "bad-b"]);
    expect((await store.list()).corrupt).toEqual([]);
  });

  test("without IndexedDB there is no store", () => {
    expect(openRecordStore(undefined)).toBeNull();
  });
});
