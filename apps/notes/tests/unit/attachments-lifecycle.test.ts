import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { AttachmentCache } from "../../src/attachment-cache";
import { followAttachmentCache } from "../../src/attachment-cache-lifecycle";
import {
  browserAccountHints,
  SessionController,
  type SessionCheck,
} from "../../src/session";

/**
 * Review round 1 of B3, F1: the attachment cache lifecycle on any page that
 * owns a session (the app, and the connect, invitation and reset pages).
 * Real SessionController, account hint and AttachmentCache over fake
 * storage and IndexedDB.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4a";
let count = 0;
const name = () => `attachments-lifecycle-${++count}`;
const bytes = (n: number) =>
  new Blob([new Uint8Array(n)], { type: "image/png" });

/** A storage area for the account hint, shared like localStorage. */
function storageArea() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function page(cache: AttachmentCache, first: SessionCheck) {
  let answer = first;
  const hints = browserAccountHints(storageArea());
  const session = new SessionController({
    service: { check: async () => answer, signOut: async () => undefined },
    hints,
    clearAccount: async () => undefined,
    finishCleanup: async () => undefined,
    settleAccount: async () => true,
  });
  const events = new EventTarget();
  const stop = followAttachmentCache(session, {
    cache,
    hints,
    events: events as unknown as Window,
  });
  session.start();
  return {
    session,
    hints,
    events,
    stop,
    async answer(next: SessionCheck) {
      answer = next;
      session.retry({ afterSignIn: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cache.settled();
    },
  };
}
const ready = (accountId: string): SessionCheck => ({
  kind: "ready",
  accountId,
});

describe("F1: the lifecycle on any page that owns a session", () => {
  test("a revoked session clears the bytes", async () => {
    const cache = new AttachmentCache(name());
    const on = page(cache, ready("ada"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.store("ada", OBJECT, bytes(8), await cache.ticket("ada"));
    expect(await cache.objects("ada")).toEqual([OBJECT]);
    await on.answer({ kind: "revoked", accountId: "ada" });
    expect(on.session.getSnapshot().status).toBe("revoked");
    expect(await cache.objects("ada")).toEqual([]);
    on.stop();
    cache.close();
  });

  test("switching accounts clears the previous account's bytes", async () => {
    const cache = new AttachmentCache(name());
    const on = page(cache, ready("ada"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.store("ada", OBJECT, bytes(8), await cache.ticket("ada"));
    await on.answer(ready("bob"));
    expect(on.session.getSnapshot().accountId).toBe("bob");
    expect(await cache.objects("ada")).toEqual([]);
    expect(await cache.read("ada", OBJECT)).toBeNull();
    // Bob's own bytes are kept.
    await cache.store("ada", OBJECT, bytes(8));
    await cache.store("bob", OBJECT, bytes(8), await cache.ticket("bob"));
    expect(await cache.objects("bob")).toEqual([OBJECT]);
    on.stop();
    cache.close();
  });

  test("another tab's sign-out, through the shared hint, clears the bytes", async () => {
    const cache = new AttachmentCache(name());
    const on = page(cache, ready("ada"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.store("ada", OBJECT, bytes(8), await cache.ticket("ada"));
    // Another tab signed out: the hint changes before this page's session
    // hears of it.
    on.hints.signedOut("ada");
    on.events.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "palladian.notes.account-hint.v1",
      }),
    );
    await cache.settled();
    expect(await cache.objects("ada")).toEqual([]);
    expect(await cache.read("ada", OBJECT)).toBeNull();
    on.stop();
    cache.close();
  });

  test("a clean-up a closed page left unfinished is finished at the next start", async () => {
    const db = name();
    const before = new AttachmentCache(db);
    await before.retain("ada");
    await before.store("ada", OBJECT, bytes(8));
    before.close();
    // The hint says Ada was being cleaned up when the page went away.
    const cache = new AttachmentCache(db);
    const hints = browserAccountHints(storageArea());
    hints.hideForCleanup("ada");
    const session = new SessionController({
      service: { check: () => new Promise<SessionCheck>(() => undefined) },
      hints,
      clearAccount: async () => undefined,
      finishCleanup: async () => undefined,
      settleAccount: async () => true,
    });
    const stop = followAttachmentCache(session, {
      cache,
      hints,
      events: new EventTarget() as unknown as Window,
    });
    await cache.settled();
    expect(await cache.objects("ada")).toEqual([]);
    stop();
    cache.close();
  });
});
