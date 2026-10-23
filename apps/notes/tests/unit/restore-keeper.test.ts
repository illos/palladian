import { describe, expect, test } from "vitest";
import {
  PENDING_RESTORES_KEY,
  RestoreKeeper,
  type KeeperStorage,
  type PendingRestore,
} from "../../src/restore-keeper";
import type { RestoreOutcome } from "../../src/versions";

// Review round 3 (R3-1, R3-5): the life of an unresolved restore. One
// `MemoryStorage` stands for this browser's localStorage, shared by windows;
// each `RestoreKeeper` is one window (or one page load).

class MemoryStorage implements KeeperStorage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.values.set(key, value);
  }
}

const record = (over: Partial<PendingRestore> = {}): PendingRestore => ({
  accountId: "account-a",
  noteId: "note-1",
  revision: 3,
  expectedRevision: 10,
  requestId: "request-1",
  versionEndedAt: 1_000,
  since: 2_000,
  ...over,
});

/** A server stand-in whose answers the test releases one at a time. */
function gatedServer() {
  const sent: PendingRestore[] = [];
  const answers: ((outcome: RestoreOutcome) => void)[] = [];
  return {
    sent,
    send: (request: PendingRestore) => {
      sent.push(request);
      return new Promise<RestoreOutcome>((resolve) => answers.push(resolve));
    },
    answer(outcome: RestoreOutcome) {
      answers.shift()!(outcome);
    },
  };
}

const stored = (storage: MemoryStorage) =>
  JSON.parse(storage.getItem(PENDING_RESTORES_KEY) ?? "[]");

describe("restore keeper", () => {
  test("records the restore before sending it, and holds its note", async () => {
    const storage = new MemoryStorage();
    let storedWhenSent: unknown = null;
    const keeper = new RestoreKeeper(storage, async () => {
      storedWhenSent = stored(storage);
      return { kind: "restored" };
    });
    const sending = keeper.restore(record());
    expect(keeper.holding("account-a", "note-1")).toEqual(record());
    expect(keeper.getState().inFlight.has("request-1")).toBe(true);
    await sending;
    expect(storedWhenSent).toEqual([record()]);
  });

  test("the hold is per account and note, not per opening", () => {
    const keeper = new RestoreKeeper(new MemoryStorage(), gatedServer().send);
    void keeper.restore(record());
    expect(keeper.holding("account-a", "note-1")).toBeDefined();
    expect(keeper.holding("account-a", "note-2")).toBeUndefined();
    expect(keeper.holding("account-b", "note-1")).toBeUndefined();
  });

  test("a known outcome clears the record; no answer keeps it", async () => {
    for (const outcome of [
      { kind: "restored" },
      { kind: "conflict" },
      { kind: "refused", message: "Note not found." },
    ] as const) {
      const storage = new MemoryStorage();
      const server = gatedServer();
      const keeper = new RestoreKeeper(storage, server.send);
      const sending = keeper.restore(record());
      await Promise.resolve();
      server.answer(outcome);
      expect(await sending).toEqual(outcome);
      expect(keeper.holding("account-a", "note-1")).toBeUndefined();
      expect(stored(storage)).toEqual([]);
      expect(keeper.getState().inFlight.size).toBe(0);
    }
    const storage = new MemoryStorage();
    const keeper = new RestoreKeeper(storage, async () => {
      throw new Error("connection lost");
    });
    expect(await keeper.restore(record())).toEqual({ kind: "unanswered" });
    expect(keeper.holding("account-a", "note-1")).toEqual(record());
    expect(stored(storage)).toEqual([record()]);
    expect(keeper.getState().inFlight.size).toBe(0);
  });

  test("a reload keeps the hold, and reconciling sends the same request", async () => {
    const storage = new MemoryStorage();
    // The page reloads while the first request is still unanswered.
    void new RestoreKeeper(storage, gatedServer().send).restore(record());
    const server = gatedServer();
    const reloaded = new RestoreKeeper(storage, server.send);
    const held = reloaded.holding("account-a", "note-1");
    expect(held).toEqual(record());
    expect(reloaded.getState().inFlight.size).toBe(0);
    const checking = reloaded.check(held!);
    await Promise.resolve();
    // Exactly the same request: the server answers it once, from its receipt
    // if the first one applied.
    expect(server.sent).toEqual([record()]);
    server.answer({ kind: "restored" });
    await checking;
    expect(reloaded.holding("account-a", "note-1")).toBeUndefined();
    expect(stored(storage)).toEqual([]);
  });

  test("checking while a request is in flight shares it", async () => {
    const server = gatedServer();
    const keeper = new RestoreKeeper(new MemoryStorage(), server.send);
    const first = keeper.restore(record());
    const second = keeper.check(record());
    await Promise.resolve();
    expect(server.sent).toHaveLength(1);
    server.answer({ kind: "conflict" });
    expect(await first).toEqual({ kind: "conflict" });
    expect(await second).toEqual({ kind: "conflict" });
  });

  test("another window's records arrive with reload(), and stay when this one writes", async () => {
    const storage = new MemoryStorage();
    const here = new RestoreKeeper(storage, gatedServer().send);
    const there = new RestoreKeeper(storage, async () => ({
      kind: "restored",
    }));
    void there.restore(record({ requestId: "there", noteId: "note-2" }));
    expect(here.holding("account-a", "note-2")).toBeUndefined();
    let notified = 0;
    here.subscribe(() => notified++);
    here.reload();
    expect(notified).toBe(1);
    expect(here.holding("account-a", "note-2")?.requestId).toBe("there");
    // This window adds its own record without dropping the other one.
    void here.restore(record());
    expect(stored(storage).map((r: PendingRestore) => r.requestId)).toEqual([
      "there",
      "request-1",
    ]);
  });

  test("storage that fails still holds the note in this window", async () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const keeper = new RestoreKeeper(storage, gatedServer().send);
    void keeper.restore(record());
    expect(keeper.holding("account-a", "note-1")).toEqual(record());
    const none = new RestoreKeeper(null, gatedServer().send);
    void none.restore(record());
    expect(none.holding("account-a", "note-1")).toEqual(record());
  });

  test("malformed or foreign stored values are ignored", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      PENDING_RESTORES_KEY,
      JSON.stringify([
        record(),
        { ...record({ requestId: "x" }), revision: "3" },
        { accountId: "a" },
        null,
      ]),
    );
    expect(
      new RestoreKeeper(storage, gatedServer().send).getState().pending,
    ).toEqual([record()]);
    storage.values.set(PENDING_RESTORES_KEY, "{not json");
    expect(
      new RestoreKeeper(storage, gatedServer().send).getState().pending,
    ).toEqual([]);
  });
});
