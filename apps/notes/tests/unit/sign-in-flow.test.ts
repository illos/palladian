import "fake-indexeddb/auto";
// The installed Better Auth client (with the repo's cross-domain patch) over a
// fake auth server and a fake platform authenticator.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
const page = Object.assign(new EventTarget(), { localStorage: storage });
Object.assign(globalThis, {
  window: page,
  localStorage: storage,
  PublicKeyCredential: function PublicKeyCredential() {},
});

let prompt: {
  resolve: (credential: unknown) => void;
  aborted: boolean;
} | null = null;
Object.defineProperty(navigator, "credentials", {
  configurable: true,
  value: {
    get: (options: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const current = { resolve, aborted: false };
        prompt = current;
        options.signal?.addEventListener("abort", () => {
          current.aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  },
});
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const assertion = {
  id: "cred",
  rawId: bytes("cred"),
  type: "public-key",
  authenticatorAttachment: "platform",
  response: {
    authenticatorData: bytes("data"),
    clientDataJSON: bytes("{}"),
    signature: bytes("sig"),
    userHandle: null,
  },
  getClientExtensionResults: () => ({}),
};

const server = {
  requests: [] as string[],
  clearSessionOnOptions: false,
  session: null as null | { createdAt: string },
  devices: {} as Record<string, { known: boolean; behind: boolean }>,
  statusFails: false,
  bindAnswer: 200,
  binds: [] as (string | null)[],
  statusGate: null as null | Promise<void>,
  signInGate: null as null | Promise<void>,
};
function cookieResponse(body: unknown, cookies: string[]) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Better-Auth-Cookie": cookies.join(", "),
    },
  });
}
const user = { id: "u", email: "ada@example.com", name: "Ada" };
let issued = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === CONVEX) {
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: unknown;
    };
    const ok = (value: unknown) =>
      new Response(JSON.stringify({ status: "success", value }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (body.path === "devices:bind") {
      server.binds.push(new Headers(init?.headers).get("Authorization"));
      // The fake token belongs to account "u"; the binding commits even if
      // the answer is then lost.
      server.devices.u = { known: true, behind: false };
      if (server.bindAnswer !== 200)
        return new Response("lost", { status: server.bindAnswer });
      return ok(null);
    }
    if (server.statusGate) await server.statusGate;
    if (server.statusFails) return new Response("busy", { status: 503 });
    const { accountId } = body.args as { accountId: string };
    return ok(server.devices[accountId] ?? { known: false, behind: false });
  }
  const path = url.pathname.replace("/api/auth", "");
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  server.requests.push(`${method} ${path}`);
  const session = () =>
    `better-auth.session_token=token-${++issued}; Max-Age=3600; Path=/`;
  if (path === "/passkey/generate-authenticate-options")
    return cookieResponse(
      {
        challenge: "Y2hhbGxlbmdl",
        rpId: "auth.test",
        userVerification: "preferred",
      },
      [
        "better-auth.better-auth-passkey=challenge; Max-Age=300; Path=/",
        ...(server.clearSessionOnOptions
          ? ["better-auth.session_token=; Max-Age=0; Path=/"]
          : []),
      ],
    );
  if (path === "/convex/token")
    return new Response(JSON.stringify({ token: "jwt" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (path === "/sign-in/email" && server.signInGate) await server.signInGate;
  if (path === "/passkey/verify-authentication" || path === "/sign-in/email")
    return cookieResponse({ user, session: { id: "s" } }, [session()]);
  if (path === "/get-session" && server.session)
    return new Response(
      JSON.stringify({ user, session: { id: "s", ...server.session } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  return new Response("null", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const { createAuthService, authMoment } =
  await import("../../src/auth-service");
const { NotesStore } = await import("../../src/cache");
const { passkeyCeremony, signInAfter, started } =
  await import("../../src/sign-in-flow");

function fakeSession() {
  let snapshot = {
    status: "expired" as const,
    accountId: null,
    generation: 0,
    error: null,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    retry: vi.fn(),
    decide() {
      snapshot = { ...snapshot, generation: snapshot.generation + 1 };
      for (const listener of listeners) listener();
    },
  };
}

async function promptShown() {
  await vi.waitFor(() => expect(prompt).not.toBeNull());
  return prompt!;
}
const credentialOf = (connection: ReturnType<typeof createAuthService>) =>
  authMoment(connection.auth).credential;

beforeEach(() => {
  memory.clear();
  prompt = null;
  server.requests = [];
  server.clearSessionOnOptions = false;
  server.session = null;
  server.devices = {};
  server.statusFails = false;
  server.bindAnswer = 200;
  server.binds = [];
  server.statusGate = null;
  server.signInGate = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a passkey ceremony finishes only under the sign-in it began in", () => {
  test("undisturbed, it signs in", async () => {
    const tab = createAuthService(SITE);
    const ceremony = passkeyCeremony(tab, fakeSession(), false);
    (await promptShown()).resolve(assertion);
    const result = await ceremony.result;
    expect(result?.error).toBeFalsy();
    expect(server.requests).toContain("POST /passkey/verify-authentication");
    expect(credentialOf(tab)).toMatch(/^token-/);
  });

  test("a password sign-in during the prompt wins; the late passkey stores nothing", async () => {
    const tab = createAuthService(SITE);
    const ceremony = passkeyCeremony(tab, fakeSession(), false);
    const shown = await promptShown();
    await tab.auth.signIn.email({
      email: "bo@example.com",
      password: "x".repeat(12),
    });
    const newer = credentialOf(tab);
    shown.resolve(assertion);
    expect(await ceremony.result).toBeNull();
    expect(server.requests).not.toContain(
      "POST /passkey/verify-authentication",
    );
    expect(credentialOf(tab)).toBe(newer);
  });

  test("a sign-in in another tab cancels the prompt", async () => {
    const tab = createAuthService(SITE);
    const other = createAuthService(SITE);
    const ceremony = passkeyCeremony(tab, fakeSession(), false);
    const shown = await promptShown();
    await other.auth.signIn.email({
      email: "bo@example.com",
      password: "x".repeat(12),
    });
    const newer = credentialOf(other);
    page.dispatchEvent(new Event("storage"));
    expect(await ceremony.result).toBeNull();
    expect(shown.aborted).toBe(true);
    expect(server.requests).not.toContain(
      "POST /passkey/verify-authentication",
    );
    expect(credentialOf(tab)).toBe(newer);
  });

  test("a newer session decision cancels the prompt", async () => {
    const tab = createAuthService(SITE);
    const session = fakeSession();
    const ceremony = passkeyCeremony(tab, session, false);
    const shown = await promptShown();
    session.decide();
    expect(await ceremony.result).toBeNull();
    expect(shown.aborted).toBe(true);
  });

  test("clearing a dead session while it runs is not a new sign-in", async () => {
    const tab = createAuthService(SITE);
    await tab.auth.signIn.email({
      email: "ada@example.com",
      password: "x".repeat(12),
    });
    server.clearSessionOnOptions = true;
    const ceremony = passkeyCeremony(tab, fakeSession(), false);
    (await promptShown()).resolve(assertion);
    const result = await ceremony.result;
    expect(result?.error).toBeFalsy();
    expect(server.requests).toContain("POST /passkey/verify-authentication");
  });
});

describe("signing in after a reset or account creation", () => {
  test("signs in when nothing changed meanwhile", async () => {
    const tab = createAuthService(SITE);
    const session = fakeSession();
    const since = started(session, tab);
    expect(
      await signInAfter(session, tab, since, "ada@example.com", "x".repeat(12)),
    ).toBe("signed-in");
    expect(session.retry).toHaveBeenCalledWith({ afterSignIn: true });
  });

  test("another tab's sign-in meanwhile: nobody is signed in for the stale request", async () => {
    const tab = createAuthService(SITE);
    const other = createAuthService(SITE);
    const session = fakeSession();
    const since = started(session, tab);
    await other.auth.signIn.email({
      email: "bo@example.com",
      password: "x".repeat(12),
    });
    const newer = credentialOf(other);
    server.requests = [];
    expect(
      await signInAfter(session, tab, since, "ada@example.com", "x".repeat(12)),
    ).toBe("superseded");
    expect(server.requests).toEqual([]);
    expect(session.retry).not.toHaveBeenCalled();
    expect(credentialOf(tab)).toBe(newer);
  });

  test("a newer session decision meanwhile: no automatic sign-in", async () => {
    const tab = createAuthService(SITE);
    const session = fakeSession();
    const since = started(session, tab);
    session.decide();
    expect(
      await signInAfter(session, tab, since, "ada@example.com", "x".repeat(12)),
    ).toBe("superseded");
    expect(session.retry).not.toHaveBeenCalled();
  });
});

describe("browsers holding copies from before a password reset (D98)", () => {
  const signal = () => new AbortController().signal;
  const live = { createdAt: "2026-10-18T10:00:00.000Z" };
  const copies = new Set<string>();
  const device = {
    secret: async () => "s".repeat(43),
    hasCopies: async (accountId: string) => copies.has(accountId),
  };
  const service = () => createAuthService(SITE, CONVEX, device).service;
  beforeEach(() => copies.clear());

  test("a new browser without copies is recorded before the account opens", async () => {
    server.session = live;
    expect(await service().check(signal(), null)).toEqual({
      kind: "ready",
      accountId: "u",
    });
    expect(server.binds).toEqual(["Bearer jwt"]);
  });

  test("a current browser opens without recording again", async () => {
    server.session = live;
    server.devices.u = { known: true, behind: false };
    copies.add("u");
    expect(await service().check(signal(), "u")).toEqual({
      kind: "ready",
      accountId: "u",
    });
    expect(server.binds).toEqual([]);
  });

  test("copies from before a reset are cleared first, even after signing in again", async () => {
    server.session = live;
    server.devices.u = { known: true, behind: true };
    copies.add("u");
    expect(await service().check(signal(), "u")).toEqual({
      kind: "revoked",
      accountId: "u",
    });
    // Not recorded as current until the copies are gone.
    expect(server.binds).toEqual([]);
    copies.delete("u");
    expect(await service().check(signal(), null)).toEqual({
      kind: "ready",
      accountId: "u",
    });
    expect(server.binds).toEqual(["Bearer jwt"]);
  });

  test("behind a reset but holding no copies, it opens straight away", async () => {
    server.session = live;
    server.devices.u = { known: true, behind: true };
    expect(await service().check(signal(), null)).toEqual({
      kind: "ready",
      accountId: "u",
    });
  });

  test("copies in a browser unknown here (lost identity) are cleared before opening", async () => {
    server.session = live;
    copies.add("u");
    expect(await service().check(signal(), "u")).toEqual({
      kind: "revoked",
      accountId: "u",
    });
    expect(server.binds).toEqual([]);
  });

  test("the account on screen is cleared before switching to another", async () => {
    server.session = live;
    server.devices.u = { known: true, behind: false };
    server.devices.shown = { known: true, behind: true };
    copies.add("shown");
    expect(await service().check(signal(), "shown")).toEqual({
      kind: "revoked",
      accountId: "shown",
    });
  });

  test("a lost answer to a committed recording is retried, and nothing is skipped", async () => {
    server.session = live;
    server.bindAnswer = 503;
    expect((await service().check(signal(), null)).kind).toBe("transient");
    server.bindAnswer = 200;
    expect(await service().check(signal(), null)).toEqual({
      kind: "ready",
      accountId: "u",
    });
  });

  test("no session, behind a reset, holding copies: revoked", async () => {
    server.devices.u = { known: true, behind: true };
    copies.add("u");
    expect(await service().check(signal(), "u")).toEqual({
      kind: "revoked",
      accountId: "u",
    });
  });

  test("no session otherwise: plain expiry keeps the copies", async () => {
    copies.add("u");
    expect(await service().check(signal(), "u")).toEqual({ kind: "expired" });
    server.devices.u = { known: true, behind: false };
    expect(await service().check(signal(), "u")).toEqual({ kind: "expired" });
    server.devices.u = { known: true, behind: true };
    copies.clear();
    expect(await service().check(signal(), "u")).toEqual({ kind: "expired" });
    expect(await service().check(signal(), null)).toEqual({ kind: "expired" });
  });

  test("a failed question is retried, never taken as revocation", async () => {
    server.statusFails = true;
    copies.add("u");
    expect((await service().check(signal(), "u")).kind).toBe("transient");
    server.session = live;
    expect((await service().check(signal(), "u")).kind).toBe("transient");
  });

  test("without a device store nothing is asked", async () => {
    server.session = live;
    const { service: plain } = createAuthService(SITE, CONVEX);
    expect(await plain.check(signal(), "u")).toEqual({
      kind: "ready",
      accountId: "u",
    });
    expect(server.binds).toEqual([]);
  });

  for (const withSession of [false, true])
    test(`a sign-in in another tab outranks a late answer (${withSession ? "live session" : "no session"})`, async () => {
      server.session = withSession ? live : null;
      server.devices.u = { known: true, behind: !withSession };
      copies.add("u");
      const other = createAuthService(SITE, CONVEX);
      let release!: () => void;
      server.statusGate = new Promise<void>((resolve) => (release = resolve));
      const checking = service().check(signal(), "u");
      await vi.waitFor(() =>
        expect(server.requests).toContain("GET /get-session"),
      );
      await other.auth.signIn.email({
        email: "bo@example.com",
        password: "x".repeat(12),
      });
      release();
      expect((await checking).kind).toBe("transient");
    });
});

describe("the device secret lives in the notes cache", () => {
  test("tabs creating it at once agree on one secret", async () => {
    const name = "device-" + crypto.randomUUID();
    const first = new NotesStore(name);
    const second = new NotesStore(name);
    const [a, b] = await Promise.all([
      first.deviceSecret(),
      second.deviceSecret(),
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await first.deviceSecret()).toBe(a);
  });

  test("copies are counted per account", async () => {
    const store = new NotesStore("copies-" + crypto.randomUUID());
    expect(await store.hasCopies("u")).toBe(false);
    const db = (
      store as unknown as {
        db: { drafts: { put(row: unknown): Promise<unknown> } };
      }
    ).db;
    await db.drafts.put({ accountId: "u", id: "n1", doc: "{}", updatedAt: 1 });
    expect(await store.hasCopies("u")).toBe(true);
    expect(await store.hasCopies("someone-else")).toBe(false);
  });
});

describe("a completed reset or account survives a cut-off automatic sign-in", () => {
  test("another tab's sign-in aborting ours is reported, not thrown", async () => {
    const tab = createAuthService(SITE);
    const other = createAuthService(SITE);
    const session = fakeSession();
    const since = started(session, tab);
    let release!: () => void;
    server.signInGate = new Promise<void>((resolve) => (release = resolve));
    const outcome = signInAfter(
      session,
      tab,
      since,
      "ada@example.com",
      "x".repeat(12),
    );
    await vi.waitFor(() =>
      expect(server.requests).toContain("POST /sign-in/email"),
    );
    server.signInGate = null;
    await other.auth.signIn.email({
      email: "bo@example.com",
      password: "x".repeat(12),
    });
    release();
    expect(await outcome).not.toBe("signed-in");
    expect(session.retry).not.toHaveBeenCalled();
  });
});
