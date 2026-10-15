import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore, type ActivationFence } from "../../src/cache";
import {
  SessionController,
  browserAccountHints,
  type SessionCheck,
} from "../../src/session";
import { draftOf } from "./fake-server";

/** One browser tab: a store and a session wired as main.tsx wires them. */
function tab(name: string, storage: Map<string, string>) {
  const store = new NotesStore(name);
  const hints = browserAccountHints({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
  });
  let activation: ActivationFence | null = null;
  let activated: string | null = null;
  let result: SessionCheck = { kind: "ready", accountId: "account" };
  const session = new SessionController({
    service: {
      async check() {
        const fence = await store.captureActivationFence();
        activation = fence;
        return result;
      },
    },
    hints,
    async clearAccount(accountId) {
      activated = null;
      await store.clearAccount(accountId);
    },
    accountBlocked: (accountId) => store.accountBlocked(accountId),
    settleAccount: async () => true,
    prepareLogout: async () => true,
    async onAccountReady(accountId, isCurrent) {
      if (activated === accountId) return;
      if (!activation) throw new Error("no activation");
      await store.allowAccount(accountId, activation, isCurrent);
      activated = accountId;
    },
  });
  store.subscribe((event) => {
    if (!event.invalidated || !event.accountId) return;
    if (activated === event.accountId) activated = null;
    session.adoptInvalidation(event.accountId);
  });
  return {
    store,
    session,
    signIn(accountId: string) {
      result = { kind: "ready", accountId };
      session.retry({ afterSignIn: true });
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("a cleanup another tab finished cannot erase a later sign-in", () => {
  for (const held of [false, true])
    test(`new ${held ? "held" : "accessible"} work survives the other tab signing in`, async () => {
      const name = "r12-" + crypto.randomUUID();
      const storage = new Map<string, string>();
      const first = tab(name, storage);
      const second = tab(name, storage);
      try {
        first.session.start();
        second.session.start();
        await settle();
        expect(second.session.getSnapshot().status).toBe("ready");
        // Tab 1 signs out, clearing the account; tab 2 learns of it.
        expect(await first.session.logout()).toBe(true);
        await settle();
        expect(second.session.getSnapshot().accountId).toBeNull();
        // Tab 1 signs in again and saves new work.
        first.signIn("account");
        await settle();
        expect(first.session.getSnapshot().status).toBe("ready");
        await first.store.cacheSummaries(
          "account",
          [
            {
              id: "note",
              title: "New",
              preview: "",
              updatedAt: 1,
              notebookId: "gone",
              role: "edit",
              trashed: false,
            },
          ],
          [],
          await first.store.captureFence("account"),
        );
        await first.store.writeDraft(
          draftOf(markdownToDoc("New work"), { notebookId: "gone" }),
        );
        if (held)
          await first.store.reconcileAccess(
            "account",
            new Set(),
            new Set(),
            await first.store.captureFence("account"),
          );
        // Tab 2 now signs in too.
        second.signIn("account");
        await settle();
        expect(await first.store.unsavedWork("account")).toEqual({
          total: 1,
          held: held ? 1 : 0,
        });
        expect(second.session.getSnapshot().status).toBe("ready");
        expect(first.session.getSnapshot().status).toBe("ready");
      } finally {
        first.session.stop();
        second.session.stop();
        first.store.close();
        second.store.close();
      }
    });
});
