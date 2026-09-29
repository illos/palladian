import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionController,
  browserAccountHints,
  type SessionCheck,
  type SessionService,
} from "../src/session.ts";
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(service: SessionService, accountId: string | null = "owner") {
  const memory = new Map<string, string>();
  const hints = browserAccountHints({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  });
  if (accountId) hints.remember(accountId);
  const jobs: { fn: () => void; delay: number; cancelled: boolean }[] = [];
  const cleared: string[] = [];
  const session = new SessionController({
    service,
    hints,
    clearAccount: async (account) => {
      cleared.push(account);
    },
    schedule: (fn, delay) => {
      const job = { fn, delay, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
  });
  return { session, hints, cleared, jobs, memory };
}
test("cached account is immediately readable before a stalled token request", async () => {
  const pending = deferred<SessionCheck>();
  let calls = 0;
  const { session, jobs, cleared } = setup({
    check: async () => {
      calls++;
      return pending.promise;
    },
  });
  assert.equal(session.getSnapshot().accountId, "owner");
  session.start();
  session.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().status, "connecting");
  jobs.find((j) => j.delay === 8000)?.fn();
  await flush();
  assert.equal(session.getSnapshot().status, "retrying");
  assert.equal(session.getSnapshot().accountId, "owner");
  assert.deepEqual(cleared, []);
  pending.resolve({ kind: "ready", accountId: "stale" });
  await flush();
  assert.equal(session.getSnapshot().accountId, "owner");
  session.stop();
});
test("network, 429/5xx classification, and unknown errors never sign out or clear cache", async () => {
  const { session, hints, cleared } = setup({
    check: async () => {
      throw new Error("synthetic failure");
    },
  });
  session.start();
  await flush();
  assert.equal(session.getSnapshot().status, "retrying");
  assert.equal(hints.read().accountId, "owner");
  assert.deepEqual(cleared, []);
  session.stop();
});
test("authoritative expiry preserves cached viewing and recovery", async () => {
  const { session, cleared, hints } = setup({
    check: async () => ({ kind: "expired" }),
  });
  session.start();
  await flush();
  assert.equal(session.getSnapshot().status, "expired");
  assert.equal(session.getSnapshot().accountId, "owner");
  assert.equal(hints.read().accountId, "owner");
  assert.deepEqual(cleared, []);
  session.stop();
});
test("revocation clears only matching account and hides cached identity immediately", async () => {
  const { session, hints, cleared } = setup({
    check: async () => ({ kind: "revoked", accountId: "owner" }),
  });
  session.start();
  await flush();
  assert.equal(session.getSnapshot().status, "revoked");
  assert.equal(session.getSnapshot().accountId, null);
  assert.equal(hints.read().signedOut, true);
  assert.deepEqual(cleared, ["owner"]);
  session.stop();
});
test("a mismatched revocation result cannot erase a newer account", async () => {
  const { session, cleared } = setup({
    check: async () => ({ kind: "revoked", accountId: "other" }),
  });
  session.start();
  await flush();
  assert.deepEqual(cleared, []);
  assert.equal(session.getSnapshot().accountId, "owner");
  session.stop();
});
test("stopped and superseded auth callbacks cannot restore identity", async () => {
  const pending = deferred<SessionCheck>();
  const { session } = setup({ check: async () => pending.promise });
  session.start();
  await flush();
  session.stop();
  pending.resolve({ kind: "ready", accountId: "other" });
  await flush();
  assert.equal(session.getSnapshot().accountId, "owner");
});
test("explicit logout intent survives a failed remote sign-out and passive reload", async () => {
  const pending = deferred<SessionCheck>();
  const { session, hints, cleared, memory } = setup({
    check: async () => pending.promise,
    signOut: async () => {
      throw new Error("offline");
    },
  });
  session.start();
  await flush();
  assert.equal(await session.logout(), true);
  pending.resolve({ kind: "ready", accountId: "owner" });
  await flush();
  assert.equal(session.getSnapshot().status, "signed-out");
  assert.deepEqual(cleared, ["owner"]);
  assert.equal(hints.read().signedOut, true);
  let calls = 0;
  const again = new SessionController({
    service: {
      check: async () => {
        calls++;
        return { kind: "ready", accountId: "owner" };
      },
    },
    hints: browserAccountHints({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    }),
    clearAccount: async () => {},
  });
  again.start();
  await flush();
  assert.equal(calls, 0);
  assert.equal(again.getSnapshot().accountId, null);
  again.stop();
  session.stop();
});
test("ordinary account switch clears previous data before readiness", async () => {
  const cleanup = deferred<void>();
  let cleaned = false;
  const hints = {
    read: () => ({ accountId: "a", signedOut: false }),
    remember: () => {},
    signedOut: () => {},
    hideForCleanup: () => {},
  };
  const session = new SessionController({
    service: { check: async () => ({ kind: "ready", accountId: "b" }) },
    hints,
    clearAccount: async () => {
      await cleanup.promise;
      cleaned = true;
    },
  });
  session.start();
  await flush();
  assert.equal(session.getSnapshot().accountId, null);
  assert.equal(session.getSnapshot().status, "connecting");
  cleanup.resolve();
  await flush();
  assert.equal(cleaned, true);
  assert.equal(session.getSnapshot().accountId, "b");
  session.stop();
});
test("logout fences inflight account changes before preparing unsaved work", async () => {
  const pending = deferred<SessionCheck>();
  const preparation = deferred<boolean>();
  const cleared: string[] = [];
  const session = new SessionController({
    service: { check: async () => pending.promise },
    hints: {
      read: () => ({ accountId: "a", signedOut: false }),
      remember: () => {},
      signedOut: () => {},
      hideForCleanup: () => {},
    },
    clearAccount: async (a) => {
      cleared.push(a);
    },
    prepareLogout: async () => preparation.promise,
  });
  session.start();
  await flush();
  const loggingOut = session.logout();
  pending.resolve({ kind: "ready", accountId: "b" });
  await flush();
  assert.equal(session.getSnapshot().accountId, "a");
  preparation.resolve(true);
  assert.equal(await loggingOut, true);
  assert.deepEqual(cleared, ["a"]);
  session.stop();
});
test("failed old-account cleanup cannot be bypassed by retry", async () => {
  let fail = true;
  let calls = 0;
  const session = new SessionController({
    service: { check: async () => ({ kind: "ready", accountId: "b" }) },
    hints: {
      read: () => ({ accountId: "a", signedOut: false }),
      remember: () => {},
      signedOut: () => {},
      hideForCleanup: () => {},
    },
    clearAccount: async () => {
      calls++;
      if (fail) throw new Error("quota");
    },
  });
  session.start();
  await flush();
  assert.equal(session.getSnapshot().accountId, null);
  assert.equal(session.getSnapshot().status, "connecting");
  session.retry();
  await flush();
  assert.equal(calls, 2);
  assert.notEqual(session.getSnapshot().status, "ready");
  fail = false;
  session.retry();
  await flush();
  assert.equal(calls, 3);
  assert.equal(session.getSnapshot().accountId, "b");
  session.stop();
});
test("async account cache activation cannot publish readiness after stop", async () => {
  const activate = deferred<void>();
  const session = new SessionController({
    service: { check: async () => ({ kind: "ready", accountId: "b" }) },
    hints: {
      read: () => ({ accountId: null, signedOut: false }),
      remember: () => {},
      signedOut: () => {},
      hideForCleanup: () => {},
    },
    clearAccount: async () => {},
    onAccountReady: async () => activate.promise,
  });
  session.start();
  await flush();
  session.stop();
  activate.resolve();
  await flush();
  assert.notEqual(session.getSnapshot().status, "ready");
  assert.equal(session.getSnapshot().accountId, null);
});
test("hung remote logout is bounded even if transport ignores abort", async () => {
  const never = deferred<void>();
  const { session, jobs } = setup({
    check: async () => ({ kind: "ready", accountId: "owner" }),
    signOut: async () => never.promise,
  });
  session.start();
  await flush();
  const loggingOut = session.logout();
  await flush();
  const deadline = jobs.filter((j) => j.delay === 8000 && !j.cancelled).at(-1);
  assert.ok(deadline);
  deadline.fn();
  await flush();
  assert.equal(await loggingOut, true);
  assert.equal(session.getSnapshot().status, "signed-out");
  session.stop();
});
test("cross-tab invalidation fences late ready and passive retry", async () => {
  const pending = deferred<SessionCheck>();
  const { session, hints } = setup({ check: async () => pending.promise });
  session.start();
  await flush();
  hints.signedOut("owner");
  session.adoptInvalidation("owner");
  pending.resolve({ kind: "ready", accountId: "owner" });
  await flush();
  session.retry();
  assert.equal(session.getSnapshot().status, "signed-out");
  assert.equal(session.getSnapshot().accountId, null);
  assert.equal(hints.read().signedOut, true);
  session.stop();
});
test("failed cleanup survives reload without exposing prior account hint", async () => {
  const { session: unused, hints } = setup(
    { check: async () => ({ kind: "ready", accountId: "b" }) },
    "a",
  );
  unused.stop();
  const first = new SessionController({
    service: { check: async () => ({ kind: "ready", accountId: "b" }) },
    hints,
    clearAccount: async () => {
      throw new Error("storage");
    },
  });
  first.start();
  await flush();
  assert.equal(hints.read().accountId, null);
  assert.equal(hints.read().pendingCleanup, "a");
  first.stop();
  const cleaned: string[] = [];
  const second = new SessionController({
    service: { check: async () => ({ kind: "ready", accountId: "b" }) },
    hints,
    clearAccount: async (a) => {
      cleaned.push(a);
    },
  });
  assert.equal(second.getSnapshot().accountId, null);
  second.start();
  await flush();
  assert.deepEqual(cleaned, ["a"]);
  assert.equal(second.getSnapshot().accountId, "b");
  second.stop();
});
