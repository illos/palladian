// The device clean-up (D98) through the real pieces: the notes cache, the
// session controller and its wiring, and the installed Better Auth client,
// over a fake auth and Convex server. Two stores on one database are two tabs.
import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { draftOf } from "./fake-server";

const SITE = "https://auth.test";
const CONVEX = "https://convex.test";
const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), { localStorage: storage }),
  localStorage: storage,
});

const server = {
  session: false,
  devices: {} as Record<string, { known: boolean; behind: boolean }>,
  binds: 0,
  holdStatus: null as null | Promise<void>,
  statusRequests: 0,
};
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === CONVEX) {
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: { accountId: string };
    };
    if (body.path === "devices:bind") {
      server.binds++;
      server.devices[body.args.accountId] = { known: true, behind: false };
      return json({ status: "success", value: null });
    }
    server.statusRequests++;
    const held = server.holdStatus;
    server.holdStatus = null;
    // Answer as of when the request arrived, delivered after the hold.
    const answer = server.devices[body.args.accountId] ?? {
      known: false,
      behind: false,
    };
    if (held) await held;
    return json({ status: "success", value: answer });
  }
  const path = url.pathname.replace("/api/auth", "");
  if (path === "/convex/token") return json({ token: "jwt" });
  if (path === "/get-session" && server.session)
    return json({
      user: { id: "u", email: "ada@example.com", name: "Ada" },
      session: { id: "s", createdAt: "2026-10-18T10:00:00.000Z" },
    });
  return json(null);
}) as typeof fetch;

const { NotesStore } = await import("../../src/cache");
const { createAuthService } = await import("../../src/auth-service");
const { wireSession } = await import("../../src/session-wiring");
const { browserAccountHints } = await import("../../src/session");

let database = "";
function tab() {
  const store = new NotesStore(database);
  let transport!: ReturnType<typeof createAuthService>["service"];
  const { session, device } = wireSession({
    store,
    hints: browserAccountHints(storage),
    transport: () => transport,
    settleAccount: async () => true,
  });
  transport = createAuthService(SITE, CONVEX, device).service;
  return { store, session };
}
const status = (t: ReturnType<typeof tab>) => t.session.getSnapshot().status;
const draft = (text: string) =>
  draftOf(markdownToDoc(text), { accountId: "u", id: "n1" });

beforeEach(() => {
  memory.clear();
  database = "wiring-" + crypto.randomUUID();
  server.session = false;
  server.devices = {};
  server.binds = 0;
  server.holdStatus = null;
  server.statusRequests = 0;
});

describe("device clean-up through the cache and session controller", () => {
  test("a browser showing the account it reconciles signs in instead of signing itself out", async () => {
    server.session = true;
    browserAccountHints(storage).remember("u");
    const a = tab();
    a.session.start();
    await vi.waitFor(() => expect(status(a)).toBe("ready"), { timeout: 5000 });
    expect(a.session.getSnapshot().accountId).toBe("u");
    expect(server.binds).toBe(1);
    a.session.stop();
  });

  test("a late answer in one tab cannot clear drafts another tab created since", async () => {
    server.session = true;
    const a = tab();
    const b = tab();
    let release!: () => void;
    server.holdStatus = new Promise<void>((resolve) => (release = resolve));
    a.session.start();
    // A asked about this unknown browser; its answer is held.
    await vi.waitFor(() => expect(server.statusRequests).toBe(1));
    b.session.start();
    await vi.waitFor(() => expect(status(b)).toBe("ready"), { timeout: 5000 });
    await b.store.writeDraft(draft("Written after signing in"));
    release();
    await vi.waitFor(() => expect(status(a)).toBe("ready"), { timeout: 5000 });
    expect(status(b)).toBe("ready");
    expect(await b.store.hasDrafts("u")).toBe(true);
    a.session.stop();
    b.session.stop();
  });

  test("learning of a reset without a session drops other tabs' memory-only drafts", async () => {
    const b = new NotesStore(database);
    await b.allowAccount("u", await b.captureActivationFence(), () => true);
    const drafts = (
      b as unknown as {
        db: { drafts: { put: (...args: unknown[]) => unknown } };
      }
    ).db.drafts;
    drafts.put = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    await b.writeDraft(draft("Only in memory")).catch(() => undefined);
    const recovery = (b as unknown as { recoveryDrafts: Map<string, unknown> })
      .recoveryDrafts;
    expect(recovery.size).toBe(1);

    browserAccountHints(storage).remember("u");
    server.devices.u = { known: true, behind: true };
    const a = tab();
    a.session.start();
    await vi.waitFor(() => expect(status(a)).toBe("revoked"), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(recovery.size).toBe(0));
    a.session.stop();
  });

  test("a refused clear leaves a newer lifecycle's memory-only drafts and view alone", async () => {
    const store = new NotesStore(database);
    await store.allowAccount(
      "u",
      await store.captureActivationFence(),
      () => true,
    );
    await store.clearAccount("u");
    await store.allowAccount(
      "u",
      await store.captureActivationFence(),
      () => true,
    );
    expect(await store.lifecycleOf("u")).toBe(1);
    const drafts = (
      store as unknown as {
        db: { drafts: { put: (...args: unknown[]) => unknown } };
      }
    ).db.drafts;
    drafts.put = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    await store
      .writeDraft(draft("Newer, only in memory"))
      .catch(() => undefined);
    expect((await store.unsavedWork("u")).total).toBe(1);
    // A check that read lifecycle 0 decides to clear: it must change nothing.
    expect(
      await store.clearAccount("u", crypto.randomUUID(), { lifecycle: 0 }),
    ).toBe(false);
    expect((await store.unsavedWork("u")).total).toBe(1);
  });

  test("after a revocation's own clear, the controller cannot clear a newer lifecycle", async () => {
    browserAccountHints(storage).remember("u");
    server.devices.u = { known: true, behind: true };
    const a = tab();
    const b = new NotesStore(database);
    const clear = a.store.clearAccount.bind(a.store);
    let calls = 0;
    a.store.clearAccount = async (...args: Parameters<typeof clear>) => {
      const result = await clear(...args);
      // Between the device check's clear and the controller's, another tab
      // signs in, begins a newer lifecycle and saves work.
      if (++calls === 1) {
        await b.allowAccount("u", await b.captureActivationFence(), () => true);
        await b.writeDraft(draft("Saved in the newer lifecycle"));
      }
      return result;
    };
    a.session.start();
    await vi.waitFor(() => expect(status(a)).toBe("revoked"), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(await b.hasDrafts("u")).toBe(true);
    a.session.stop();
  });

  test("another tab's reconciling clear makes this tab check again, not sign out", async () => {
    server.session = true;
    browserAccountHints(storage).remember("u");
    const a = tab();
    const b = tab();
    let release!: () => void;
    server.holdStatus = new Promise<void>((resolve) => (release = resolve));
    a.session.start();
    await vi.waitFor(() => expect(server.statusRequests).toBe(1));
    b.session.start();
    await vi.waitFor(() => expect(status(b)).toBe("ready"), { timeout: 5000 });
    await vi.waitFor(() => expect(status(a)).toBe("ready"), { timeout: 5000 });
    release();
    expect(a.session.getSnapshot().accountId).toBe("u");
    a.session.stop();
    b.session.stop();
  });
});
