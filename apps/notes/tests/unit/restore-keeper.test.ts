import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import {
  APPLIED_HOLD_MS,
  noteHold,
  pendingRestore,
  RESTORE_RECORD_LIMIT,
  RestoreKeeper,
  sendInSession,
  type KeeperState,
  type PendingRestore,
} from "../../src/restore-keeper";
import { openRecordStore, type RecordStore } from "../../src/restore-store";
import type { RestoreOutcome } from "../../src/versions";

// Review rounds 3 and 4: the life of a restore in this browser. Each test
// gets a fresh IndexedDB; each `RestoreKeeper` on it is one window (or one
// page load) with its own connection.

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

/** A server stand-in whose answers the test gives one at a time. */
function gatedServer() {
  const sent: PendingRestore[] = [];
  const answers: ((outcome: RestoreOutcome) => void)[] = [];
  return {
    sent,
    send: (request: PendingRestore) => {
      sent.push(request);
      return new Promise<RestoreOutcome>((resolve) => answers.push(resolve));
    },
    async answer(outcome: RestoreOutcome) {
      for (let i = 0; i < 20 && !answers.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      answers.shift()!(outcome);
    },
  };
}

async function window(
  factory: IDBFactory,
  send: (request: PendingRestore) => Promise<RestoreOutcome>,
  now?: () => number,
) {
  const keeper = new RestoreKeeper(
    openRecordStore(factory),
    send,
    () => {},
    now,
  );
  await keeper.reload();
  return keeper;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
};

/** A store whose writes fail, around a real one. */
function failingWrites(store: RecordStore): RecordStore {
  return {
    list: () => store.list(),
    add: async () => {
      throw new Error("QuotaExceededError");
    },
    markApplied: () => store.markApplied("", 0, 0),
    remove: () => store.remove([]),
  };
}

describe("restore keeper", () => {
  test("records the restore durably before sending it, and holds its note", async () => {
    const factory = new IDBFactory();
    const reader = openRecordStore(factory)!;
    let storedWhenSent: PendingRestore[] = [];
    const keeper = await window(factory, async () => {
      storedWhenSent = (await reader.list()).records;
      return { kind: "restored", revision: 11 };
    });
    expect(await keeper.restore(record())).toEqual({
      kind: "restored",
      revision: 11,
    });
    expect(storedWhenSent).toEqual([record()]);
  });

  test("a record that cannot be written is never sent (R4-1)", async () => {
    const factory = new IDBFactory();
    const server = gatedServer();
    // An earlier restore is recorded and unresolved.
    const before = await window(factory, server.send);
    void before.restore(record({ requestId: "earlier", noteId: "note-0" }));
    await until(() => server.sent.length === 1);
    // This window's writes now fail (quota).
    const failing = new RestoreKeeper(
      failingWrites(openRecordStore(factory)!),
      server.send,
    );
    await failing.reload();
    expect(await failing.restore(record())).toEqual({
      kind: "not-recorded",
      reason: "failed",
    });
    expect(server.sent).toHaveLength(1);
    // The failed write erased nothing: the earlier record still holds its note.
    const state = failing.getState();
    expect(noteHold(state, "account-a", "note-0", 5, 0)?.reason).toBe(
      "unconfirmed",
    );
    expect(noteHold(state, "account-a", "note-1", 5, 0)).toBeNull();
    // After a reload, the same: only the earlier record exists.
    const reloaded = await window(factory, server.send);
    expect(reloaded.getState().records.map((r) => r.requestId)).toEqual([
      "earlier",
    ]);
    // Another restore from a window whose writes work goes through normally.
    void reloaded.restore(record({ requestId: "later" }));
    await until(() => server.sent.length === 2);
  });

  test("without a store, restores are refused and never sent (R4-1)", async () => {
    const server = gatedServer();
    const keeper = new RestoreKeeper(null, server.send);
    await keeper.reload();
    expect(keeper.getState().status).toBe("unavailable");
    expect(await keeper.restore(record())).toEqual({
      kind: "not-recorded",
      reason: "unavailable",
    });
    expect(server.sent).toHaveLength(0);
  });

  test("past the limit, new restores are refused and none evicted (R4-5)", async () => {
    const factory = new IDBFactory();
    const server = gatedServer();
    const keeper = await window(factory, server.send);
    for (let i = 0; i < RESTORE_RECORD_LIMIT; i++)
      void keeper.restore(record({ requestId: `r${i}`, noteId: `n${i}` }));
    await until(() => server.sent.length === RESTORE_RECORD_LIMIT);
    expect(await keeper.restore(record({ requestId: "one-more" }))).toEqual({
      kind: "not-recorded",
      reason: "full",
    });
    expect(keeper.getState().records).toHaveLength(RESTORE_RECORD_LIMIT);
  });

  test("success keeps the record as applied; refusals remove it; no answer keeps it", async () => {
    const factory = new IDBFactory();
    for (const [outcome, kept] of [
      [{ kind: "restored", revision: 12 }, "applied"],
      [{ kind: "conflict" }, "removed"],
      [{ kind: "refused", message: "Note not found." }, "removed"],
      [{ kind: "unanswered" }, "pending"],
    ] as const) {
      const keeper = await window(factory, async () => outcome);
      const requestId = `${outcome.kind}-request`;
      await keeper.restore(record({ requestId }));
      const stored = keeper
        .getState()
        .records.find((r) => r.requestId === requestId);
      if (kept === "removed") expect(stored).toBeUndefined();
      else if (kept === "pending") {
        expect(stored?.appliedRevision).toBeUndefined();
        expect(keeper.getState().inFlight.size).toBe(0);
      } else expect(stored?.appliedRevision).toBe(12);
    }
  });

  test("an editor is held until it has the applied revision (R4-4)", () => {
    const applied = record({ appliedRevision: 12, appliedAt: 1_000 });
    const state: KeeperState = {
      status: "ready",
      records: [applied],
      corrupt: [],
      inFlight: new Map(),
    };
    // Behind the restore, or not yet attached: held.
    expect(noteHold(state, "account-a", "note-1", 11, 1_000)?.reason).toBe(
      "arriving",
    );
    expect(noteHold(state, "account-a", "note-1", null, 1_000)?.reason).toBe(
      "arriving",
    );
    // At or past it: free.
    expect(noteHold(state, "account-a", "note-1", 12, 1_000)).toBeNull();
    expect(noteHold(state, "account-a", "note-1", 15, 1_000)).toBeNull();
    // The hold is bounded in time.
    expect(
      noteHold(state, "account-a", "note-1", 11, 1_000 + APPLIED_HOLD_MS),
    ).toBeNull();
    // An applied restore does not block another restore of the note.
    expect(pendingRestore(state, "account-a", "note-1")).toBeUndefined();
  });

  test("holds are per account and note; pending holds whatever the revision", () => {
    const state: KeeperState = {
      status: "ready",
      records: [record()],
      corrupt: [],
      inFlight: new Map([["request-1", 5]]),
    };
    expect(noteHold(state, "account-a", "note-1", 999, 0)?.reason).toBe(
      "sending",
    );
    expect(
      noteHold({ ...state, inFlight: new Map() }, "account-a", "note-1", 999, 0)
        ?.reason,
    ).toBe("unconfirmed");
    expect(noteHold(state, "account-a", "note-2", 0, 0)).toBeNull();
    expect(noteHold(state, "account-b", "note-1", 0, 0)).toBeNull();
    expect(pendingRestore(state, "account-a", "note-1")).toEqual(record());
    // Until the records are read, every note waits.
    expect(
      noteHold({ ...state, status: "loading" }, "account-b", "x", 0, 0)?.reason,
    ).toBe("loading");
  });

  test("unreadable records hold their account's notes until resolved (R4-5)", async () => {
    const state: KeeperState = {
      status: "ready",
      records: [],
      corrupt: [{ key: "bad", accountId: "account-a" }],
      inFlight: new Map(),
    };
    expect(noteHold(state, "account-a", "any-note", 5, 0)?.reason).toBe(
      "unreadable",
    );
    expect(noteHold(state, "account-b", "any-note", 5, 0)).toBeNull();
    // An entry whose account cannot be read holds every account's notes.
    expect(
      noteHold(
        { ...state, corrupt: [{ key: "bad", accountId: null }] },
        "account-b",
        "any-note",
        5,
        0,
      )?.reason,
    ).toBe("unreadable");
  });

  test("discarding unreadable records removes only them", async () => {
    const factory = new IDBFactory();
    const keeper = await window(factory, async () => ({ kind: "unanswered" }));
    await keeper.restore(record());
    await new Promise<void>((resolve) => {
      const open = factory.open("palladian-restores", 1);
      open.onsuccess = () => {
        const tx = open.result.transaction("restores", "readwrite");
        tx.objectStore("restores").put({ junk: true }, "bad");
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
    await keeper.reload();
    expect(keeper.getState().corrupt).toEqual([
      { key: "bad", accountId: null },
    ]);
    await keeper.discardUnreadable();
    expect(keeper.getState().corrupt).toEqual([]);
    expect(keeper.getState().records.map((r) => r.requestId)).toEqual([
      "request-1",
    ]);
  });

  test("a reload keeps the hold; reconciling sends the same request", async () => {
    const factory = new IDBFactory();
    // The first page sends the restore (so it is recorded) and then reloads
    // before any answer.
    const first = gatedServer();
    void (await window(factory, first.send)).restore(record());
    await until(() => first.sent.length === 1);
    const server = gatedServer();
    const reloaded = await window(factory, server.send);
    expect(reloaded.getState().records).toEqual([record()]);
    const held = pendingRestore(reloaded.getState(), "account-a", "note-1");
    expect(held).toEqual(record());
    const checking = reloaded.check(held!);
    await server.answer({ kind: "restored", revision: 12 });
    expect(await checking).toEqual({ kind: "restored", revision: 12 });
    expect(server.sent).toEqual([record()]);
    expect(reloaded.getState().records[0]?.appliedRevision).toBe(12);
  });

  test("a check while the request is in flight shares it", async () => {
    const server = gatedServer();
    const keeper = await window(new IDBFactory(), server.send);
    const first = keeper.restore(record());
    await until(() => server.sent.length === 1);
    const second = keeper.check(record());
    await server.answer({ kind: "conflict" });
    expect(await first).toEqual({ kind: "conflict" });
    expect(await second).toEqual({ kind: "conflict" });
    expect(server.sent).toHaveLength(1);
  });

  test("two windows' overlapping restores and completions all persist (R4-2)", async () => {
    const factory = new IDBFactory();
    const serverA = gatedServer();
    const serverB = gatedServer();
    const a = await window(factory, serverA.send);
    const b = await window(factory, serverB.send);
    // Overlapping inserts.
    const sending = [
      a.restore(record({ requestId: "a1", noteId: "n1" })),
      b.restore(record({ requestId: "b1", noteId: "n2" })),
      a.restore(record({ requestId: "a2", noteId: "n3" })),
      b.restore(record({ requestId: "b2", noteId: "n4" })),
    ];
    await until(() => serverA.sent.length === 2 && serverB.sent.length === 2);
    // Completion in one window against an insert in the other.
    const inserting = b.restore(record({ requestId: "b3", noteId: "n5" }));
    await serverA.answer({ kind: "conflict" });
    await serverA.answer({ kind: "restored", revision: 20 });
    await until(() => serverB.sent.length === 3);
    await a.reload();
    await b.reload();
    for (const keeper of [a, b])
      expect(
        keeper
          .getState()
          .records.map((r) => `${r.requestId}:${r.appliedRevision ?? "-"}`)
          .sort(),
      ).toEqual(["a2:20", "b1:-", "b2:-", "b3:-"]);
    for (let i = 0; i < 3; i++) await serverB.answer({ kind: "unanswered" });
    await Promise.all([...sending, inserting]);
  });

  test("applied records expire after their hold; pending ones stay", async () => {
    const factory = new IDBFactory();
    let now = 1_000;
    const keeper = await window(
      factory,
      async (request) =>
        request.requestId === "applied"
          ? { kind: "restored", revision: 9 }
          : { kind: "unanswered" },
      () => now,
    );
    await keeper.restore(record({ requestId: "applied" }));
    await keeper.restore(record({ requestId: "pending", noteId: "n2" }));
    now += APPLIED_HOLD_MS - 1;
    await keeper.expire();
    expect(keeper.getState().records).toHaveLength(2);
    now += 1;
    await keeper.expire();
    expect(keeper.getState().records.map((r) => r.requestId)).toEqual([
      "pending",
    ]);
  });
});

describe("sending within the recording session (R4-3)", () => {
  /** A switchable sign-in: who is signed in, and its session generation. */
  function signIn(account: string) {
    const now = { account: account as string | null, generation: 1 };
    return {
      now,
      session: {
        account: () => now.account,
        ticket: () => {
          const at = { ...now };
          return () =>
            now.account === at.account && now.generation === at.generation;
        },
      },
    };
  }

  test("sends for its own account, in an unchanged session", async () => {
    const { session } = signIn("account-a");
    const sent: PendingRestore[] = [];
    const outcome = await sendInSession(record(), session, async () => {
      return async (request) => {
        sent.push(request);
        return { kind: "restored", revision: 4 };
      };
    });
    expect(outcome).toEqual({ kind: "restored", revision: 4 });
    expect(sent).toEqual([record()]);
  });

  test("never sends another account's record", async () => {
    const { session } = signIn("account-b");
    let loaded = false;
    expect(
      await sendInSession(record(), session, async () => {
        loaded = true;
        return null;
      }),
    ).toEqual({ kind: "unanswered" });
    expect(loaded).toBe(false);
  });

  test("a switch while the sender loads stops the request", async () => {
    for (const change of [
      (now: { account: string | null; generation: number }) =>
        (now.account = "account-b"),
      (now: { account: string | null; generation: number }) =>
        (now.generation += 1),
      (now: { account: string | null; generation: number }) =>
        (now.account = null),
    ]) {
      const { now, session } = signIn("account-a");
      const sent: PendingRestore[] = [];
      const outcome = await sendInSession(record(), session, async () => {
        change(now);
        return async (request) => {
          sent.push(request);
          return { kind: "restored", revision: 4 };
        };
      });
      expect(outcome).toEqual({ kind: "unanswered" });
      expect(sent).toEqual([]);
    }
  });

  test("an answer that arrives in another session counts as unanswered", async () => {
    const { now, session } = signIn("account-a");
    const outcome = await sendInSession(record(), session, async () => {
      return async () => {
        now.account = "account-b";
        return { kind: "conflict" };
      };
    });
    expect(outcome).toEqual({ kind: "unanswered" });
  });
});
