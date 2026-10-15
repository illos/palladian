import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleApprove,
  handleAuthorize,
  handleConnect,
  handleDeny,
  handleRequestInfo,
  REQUEST_TTL_SECONDS,
  type ConsentDeps,
  type PendingRequest,
} from "../src/consent.ts";
import { ConvexCallError } from "../src/convex.ts";
import type { Env } from "../src/env.ts";
import {
  AUTH_REQUEST,
  fakeEnv,
  fakeProvider,
  FakeKV,
  ORIGIN,
  type FakeProvider,
} from "./fakes.ts";

const KEY = "k".repeat(43);

let kv: FakeKV;
let provider: FakeProvider;
let env: Env;
let redeemed: unknown[];
let redeemResult: () => Promise<{
  connectionId: string;
  agentId: string;
  clientId: string;
}>;
let deps: ConsentDeps;

beforeEach(() => {
  kv = new FakeKV();
  provider = fakeProvider();
  env = fakeEnv(kv, provider);
  redeemed = [];
  redeemResult = async () => ({
    connectionId: "conn1",
    agentId: "agent1",
    clientId: AUTH_REQUEST.clientId,
  });
  deps = {
    newKey: () => KEY,
    convex: () => ({
      mutation: (async (_fn: unknown, args: unknown) => {
        redeemed.push(args);
        return redeemResult();
      }) as never,
    }),
  };
});

function authorize() {
  return handleAuthorize(
    new Request(`${ORIGIN}/authorize?client_id=client-abc`),
    env,
    deps,
  );
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("GET /authorize", () => {
  it("parks the validated request in KV for ten minutes and redirects to /connect", async () => {
    const response = await authorize();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `${ORIGIN}/connect?request=${KEY}`,
    );
    expect(kv.puts).toEqual([
      {
        key: `connect:${KEY}`,
        options: { expirationTtl: REQUEST_TTL_SECONDS },
      },
    ]);
    expect(REQUEST_TTL_SECONDS).toBe(600);
    const stored = JSON.parse(
      kv.store.get(`connect:${KEY}`)!,
    ) as PendingRequest;
    expect(stored.oauthReqInfo).toEqual(AUTH_REQUEST);
    expect(stored.client).toMatchObject({
      clientId: "client-abc",
      clientName: "Example Agent",
      redirectHost: "client.example",
    });
  });

  it("falls back to the redirect host when the client has no name", async () => {
    provider.describe = async (request) => ({
      clientId: request.clientId,
      clientName: request.clientId,
      redirectUri: request.redirectUri,
      redirectHost: "client.example",
      redirectIsLoopback: false,
      scope: [],
    });
    await authorize();
    const stored = JSON.parse(
      kv.store.get(`connect:${KEY}`)!,
    ) as PendingRequest;
    expect(stored.client.clientName).toBe("client.example");
  });

  it("renders an error page, never a redirect, for an unvalidated redirect URI", async () => {
    provider.parse = async () => {
      throw new AuthorizationError("invalid_request", {
        description: "Invalid redirect URI",
      });
    };
    const response = await authorize();
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain("Invalid redirect URI");
    expect(kv.puts).toEqual([]);
  });

  it("escapes the library's description in the error page", async () => {
    provider.parse = async () => {
      throw new AuthorizationError("invalid_request", {
        description: "<script>x</script>",
      });
    };
    const html = await (await authorize()).text();
    expect(html).not.toContain("<script>x");
  });

  it("redirects errors only when the library validated the redirect URI", async () => {
    provider.parse = async () => {
      throw new AuthorizationError("invalid_scope", {
        description: "bad scope",
        redirectUri: "https://client.example/callback",
        state: "s1",
        issuer: ORIGIN,
      });
    };
    const response = await authorize();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(
      "https://client.example/callback",
    );
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });

  it("renders an error page when a metadata document cannot be fetched", async () => {
    provider.parse = async () => {
      throw new CimdFetchError(
        "https://client.example/oauth.json",
        new Error("HTTP 500"),
      );
    };
    const response = await authorize();
    expect(response.status).toBe(400);
    expect(kv.puts).toEqual([]);
  });
});

describe("GET /oauth/request/<key>", () => {
  it("describes the pending request for the consent page", async () => {
    await authorize();
    const response = await handleRequestInfo(
      new Request(`${ORIGIN}/oauth/request/${KEY}`),
      env,
      KEY,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      clientId: "client-abc",
      clientName: "Example Agent",
      clientUri: null,
      logoUri: null,
      redirectHost: "client.example",
      scopes: ["notes"],
    });
  });

  it("answers 404 JSON for missing, expired or malformed keys", async () => {
    for (const key of [KEY, "short", "../etc"]) {
      const response = await handleRequestInfo(
        new Request(`${ORIGIN}/oauth/request/${key}`),
        env,
        key,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toHaveProperty("error");
    }
  });
});

describe("POST /oauth/approve", () => {
  it("redeems the code, completes authorization for the agent and consumes the key", async () => {
    await authorize();
    const response = await handleApprove(
      post("/oauth/approve", { request: KEY, code: "approval-code" }),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectTo: "https://client.example/callback?code=issued&state=state-xyz",
    });
    expect(redeemed).toEqual([{ code: "approval-code", requestKey: KEY }]);
    expect(provider.completed).toEqual([
      {
        request: AUTH_REQUEST,
        userId: "agent1",
        scope: ["notes"],
        metadata: { connectionId: "conn1" },
        props: { agentId: "agent1", connectionId: "conn1" },
      },
    ]);
    expect(kv.store.has(`connect:${KEY}`)).toBe(false);

    const reused = await handleApprove(
      post("/oauth/approve", { request: KEY, code: "approval-code" }),
      env,
      deps,
    );
    expect(reused.status).toBe(404);
    expect(provider.completed).toHaveLength(1);
  });

  it.each<[string, Record<string, string>]>([
    ["a foreign Origin", { Origin: "https://evil.example" }],
    ["a missing Origin", { Origin: "" }],
    ["a cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
    ["a same-site but cross-origin fetch", { "Sec-Fetch-Site": "same-site" }],
  ])("refuses %s without consuming the request", async (_label, headers) => {
    await authorize();
    const request = post(
      "/oauth/approve",
      { request: KEY, code: "approval-code" },
      headers,
    );
    if (headers["Origin"] === "") request.headers.delete("Origin");
    const response = await handleApprove(request, env, deps);
    expect(response.status).toBe(403);
    expect(redeemed).toEqual([]);
    expect(kv.store.has(`connect:${KEY}`)).toBe(true);
  });

  it("refuses form posts, which a cross-site page could send without a preflight", async () => {
    await authorize();
    const request = new Request(`${ORIGIN}/oauth/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: `request=${KEY}&code=approval-code`,
    });
    expect((await handleApprove(request, env, deps)).status).toBe(415);
    expect(kv.store.has(`connect:${KEY}`)).toBe(true);
  });

  it("refuses an approval made for a different client", async () => {
    await authorize();
    redeemResult = async () => ({
      connectionId: "conn1",
      agentId: "agent1",
      clientId: "someone-else",
    });
    const response = await handleApprove(
      post("/oauth/approve", { request: KEY, code: "approval-code" }),
      env,
      deps,
    );
    expect(response.status).toBe(400);
    expect(provider.completed).toEqual([]);
  });

  it("maps an invalid code to 400 and an unreachable backend to 502", async () => {
    await authorize();
    redeemResult = async () => {
      throw new ConvexCallError({
        kind: "backend",
        code: "invalid",
        message: "This approval is no longer valid.",
      });
    };
    expect(
      (
        await handleApprove(
          post("/oauth/approve", { request: KEY, code: "bad" }),
          env,
          deps,
        )
      ).status,
    ).toBe(400);
    deps.newKey = () => "j".repeat(43);
    await authorize();
    redeemResult = async () => {
      throw new ConvexCallError({ kind: "uncertain", message: "down" });
    };
    const response = await handleApprove(
      post("/oauth/approve", { request: "j".repeat(43), code: "c" }),
      env,
      deps,
    );
    expect(response.status).toBe(502);
    expect(provider.completed).toEqual([]);
  });

  it("validates the body", async () => {
    const response = await handleApprove(
      post("/oauth/approve", { request: KEY }),
      env,
      deps,
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /oauth/deny", () => {
  it("consumes the request and redirects with access_denied, state and iss", async () => {
    await authorize();
    const response = await handleDeny(
      post("/oauth/deny", { request: KEY }),
      env,
    );
    expect(response.status).toBe(200);
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const url = new URL(redirectTo);
    expect(url.origin + url.pathname).toBe("https://client.example/callback");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect(kv.store.has(`connect:${KEY}`)).toBe(false);
    expect(
      (await handleDeny(post("/oauth/deny", { request: KEY }), env)).status,
    ).toBe(404);
  });

  it("refuses cross-site requests", async () => {
    await authorize();
    const response = await handleDeny(
      post("/oauth/deny", { request: KEY }, { Origin: "https://evil.example" }),
      env,
    );
    expect(response.status).toBe(403);
    expect(kv.store.has(`connect:${KEY}`)).toBe(true);
  });
});

describe("GET /connect", () => {
  it("serves the SPA so it can never be framed", async () => {
    const response = await handleConnect(
      new Request(`${ORIGIN}/connect?request=${KEY}`),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.text()).toContain("Palladian");
  });
});
