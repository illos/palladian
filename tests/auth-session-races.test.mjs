import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthClient } from "better-auth/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";

// Mock transport tests exercise the real client/plugin pipeline. All cookie,
// identity and token strings here are synthetic; real-service A07 is separate.
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(account, cookie = account) {
  return new Response(
    JSON.stringify(
      account === null
        ? null
        : {
            session: { id: `session-${account}`, userId: account },
            user: { id: account },
          },
    ),
    {
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined
          ? {}
          : {
              "set-better-auth-cookie": `better-auth.session_token=${cookie ?? ""}; Max-Age=${cookie === null ? 0 : 31536000}`,
            }),
      },
    },
  );
}
function fixture(shared = new Map()) {
  const pending = [];
  let store;
  const client = createAuthClient({
    baseURL: "https://auth.example.invalid",
    plugins: [
      convexClient(),
      crossDomainClient({
        storagePrefix: "race-test",
        disableCache: true,
        storage: {
          getItem: (key) => shared.get(key) ?? null,
          setItem: (key, value) => {
            shared.set(key, value);
          },
        },
      }),
      {
        id: "test-observer",
        getActions: (_, value) => {
          store = value;
          return {};
        },
      },
    ],
    fetchOptions: {
      customFetchImpl: async (url) => {
        const next = pending.shift();
        assert(next, "Every synthetic request must have an arranged response");
        next.dispatched.resolve(new URL(url).pathname);
        return next.result.promise;
      },
    },
  });
  function hold() {
    const next = { dispatched: deferred(), result: deferred() };
    pending.push(next);
    return {
      dispatched: next.dispatched.promise,
      release: next.result.resolve,
    };
  }
  async function login(account) {
    const request = hold();
    const result = client.signIn.email({
      email: `${account}@example.invalid`,
      password: "synthetic-test-password",
    });
    await request.dispatched;
    request.release(response(account));
    await result;
  }
  async function logout() {
    const request = hold();
    const result = client.signOut();
    await request.dispatched;
    request.release(response(null));
    await result;
  }
  return { client, hold, login, logout, store: () => store, shared };
}

test("late successful session response cannot expose A's body or invoke success after B signs in", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  let called = false;
  const request = f.client.getSession({
    fetchOptions: {
      onSuccess: () => {
        called = true;
      },
    },
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  await f.logout();
  await f.login("B");
  const expectedCookie = f.client.getCookie();
  old.release(response("A"));
  await rejected;
  assert.equal(called, false);
  assert.equal(f.client.getCookie(), expectedCookie);
});

test("late token response cannot return an old-account access token", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  const request = f.client.convex.token();
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  await f.logout();
  await f.login("B");
  old.release(
    new Response(JSON.stringify({ token: "synthetic-A-access-token" }), {
      headers: { "content-type": "application/json" },
    }),
  );
  await rejected;
});

test("empty credential ABA still cancels an earlier unauthenticated response", async () => {
  const f = fixture();
  const old = f.hold();
  const request = f.client.getSession();
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  await f.login("A");
  await f.logout();
  old.release(response(null));
  await rejected;
});

test("delayed signout response cannot clear a later successful sign-in", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  const request = f.client.signOut();
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  await f.login("B");
  const expectedCookie = f.client.getCookie();
  old.release(response(null));
  await rejected;
  assert.equal(f.client.getCookie(), expectedCookie);
});

test("renewing the same session in another client preserves current requests", async () => {
  const shared = new Map();
  const first = fixture(shared);
  const second = fixture(shared);
  await first.login("A");
  const old = first.hold();
  const request = first.client.getSession();
  await old.dispatched;
  const renewed = second.hold();
  const refresh = second.client.getSession();
  await renewed.dispatched;
  renewed.release(response("A"));
  await refresh;
  old.release(response("A"));
  assert.equal((await request).data?.user.id, "A");
});

test("account switch during body parsing cancels before caller callbacks", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  let completeBody;
  let called = false;
  const request = f.client.getSession({
    fetchOptions: {
      onSuccess: () => {
        called = true;
      },
    },
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  old.release(
    new Response(
      new ReadableStream({
        start(controller) {
          completeBody = () => {
            controller.enqueue(
              new TextEncoder().encode(
                '{"session":{"id":"session-A"},"user":{"id":"A"}}',
              ),
            );
            controller.close();
          };
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await f.logout();
  await f.login("B");
  completeBody();
  await rejected;
  assert.equal(called, false);
});

test("late unauthorized response cannot write an error over the current session atom", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  const refetch = f.store().atoms.session.get().refetch();
  await old.dispatched;
  f.shared.set("race-test_session_generation", "synthetic-new-generation");
  f.shared.set(
    "race-test_cookie",
    JSON.stringify({
      "better-auth.session_token": { value: "B", expires: null },
    }),
  );
  const current = {
    data: { session: { id: "session-B" }, user: { id: "B" } },
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: f.store().atoms.session.get().refetch,
  };
  f.store().atoms.session.set(current);
  old.release(
    new Response('{"message":"synthetic old denial"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );
  await refetch;
  assert.deepEqual(f.store().atoms.session.get(), current);
});

test("switch inside an awaited caller hook prevents later cookie writes and returned data", async () => {
  const f = fixture();
  await f.login("A");
  const old = f.hold();
  const entered = deferred();
  const finish = deferred();
  const request = f.client.getSession({
    fetchOptions: {
      onSuccess: async () => {
        entered.resolve();
        await finish.promise;
      },
    },
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  old.release(response("A"));
  await entered.promise;
  await f.logout();
  await f.login("B");
  const expectedCookie = f.client.getCookie();
  finish.resolve();
  await rejected;
  assert.equal(f.client.getCookie(), expectedCookie);
});

test("another client switching during async parsing cancels before success without storage events", async () => {
  const shared = new Map();
  const first = fixture(shared);
  const second = fixture(shared);
  await first.login("A");
  const parsed = deferred();
  const finish = deferred();
  const old = first.hold();
  let called = false;
  const request = first.client.getSession({
    fetchOptions: {
      jsonParser: async (text) => {
        parsed.resolve();
        await finish.promise;
        return JSON.parse(text);
      },
      onSuccess: () => {
        called = true;
      },
    },
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await old.dispatched;
  old.release(response("A"));
  await parsed.promise;
  await second.login("B");
  finish.resolve();
  await rejected;
  assert.equal(called, false);
  assert.match(second.client.getCookie(), /session_token=B/);
});

test("missing Web Locks fails before changing the retained device credential", async () => {
  const f = fixture();
  await f.login("A");
  const expectedCookie = f.client.getCookie();
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  try {
    await assert.rejects(f.client.signOut(), /requires Web Locks/);
    assert.equal(f.client.getCookie(), expectedCookie);
  } finally {
    if (previous) Object.defineProperty(navigator, "locks", previous);
    else delete navigator.locks;
  }
});

test("retry preserves one sign-in intent and remains usable", async () => {
  const f = fixture();
  const first = f.hold();
  const second = f.hold();
  const request = f.client.signIn.email({
    email: "A@example.invalid",
    password: "synthetic-test-password",
    fetchOptions: { retry: { type: "linear", attempts: 1, delay: 0 } },
  });
  await first.dispatched;
  const generation = f.shared.get("race-test_session_generation");
  first.release(
    new Response('{"message":"synthetic temporary outage"}', {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  await second.dispatched;
  assert.equal(f.shared.get("race-test_session_generation"), generation);
  second.release(response("A"));
  assert.equal((await request).data?.user.id, "A");
  assert.match(f.client.getCookie(), /session_token=A/);
});
