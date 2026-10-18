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
  resetSince: false as boolean | "fail",
  asked: [] as unknown[],
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
    server.asked.push(body);
    if (server.resetSince === "fail")
      return new Response("busy", { status: 503 });
    return new Response(
      JSON.stringify({ status: "success", value: server.resetSince }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
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

const { createAuthService, authMoment, sessionBegan } =
  await import("../../src/auth-service");
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
  server.resetSince = false;
  server.asked = [];
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

describe("learning of a password reset (D98)", () => {
  const signal = () => new AbortController().signal;

  test("a live session records when this device signed in", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    server.session = { createdAt: "2026-10-18T10:00:00.000Z" };
    expect(await service.check(signal())).toEqual({
      kind: "ready",
      accountId: "u",
    });
    expect(sessionBegan.read()).toEqual({
      accountId: "u",
      at: Date.parse("2026-10-18T10:00:00.000Z"),
    });
  });

  test("no session and a reset since then: revoked", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    sessionBegan.write({ accountId: "u", at: 1000 });
    server.resetSince = true;
    expect(await service.check(signal())).toEqual({
      kind: "revoked",
      accountId: "u",
    });
    expect(server.asked).toEqual([
      {
        path: "account:resetSince",
        args: { accountId: "u", since: 1000 },
        format: "json",
      },
    ]);
  });

  test("no session and no reset: ordinary expiry keeps the copies", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    sessionBegan.write({ accountId: "u", at: 1000 });
    expect(await service.check(signal())).toEqual({ kind: "expired" });
  });

  test("a failed reset check is retried, never taken as revocation", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    sessionBegan.write({ accountId: "u", at: 1000 });
    server.resetSince = "fail";
    expect((await service.check(signal())).kind).toBe("transient");
  });

  test("a device that never recorded a session only expires", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    server.resetSince = true;
    expect(await service.check(signal())).toEqual({ kind: "expired" });
    expect(server.asked).toEqual([]);
  });

  test("signing out forgets the record", async () => {
    const { service } = createAuthService(SITE, CONVEX);
    sessionBegan.write({ accountId: "u", at: 1000 });
    await service.signOut!(signal());
    expect(sessionBegan.read()).toBeNull();
  });
});
