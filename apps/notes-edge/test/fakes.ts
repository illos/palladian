import type {
  AuthRequest,
  CompleteAuthorizationOptions,
  ConsentDescription,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../src/env.ts";

export const ORIGIN = "https://palladian.example.workers.dev";

/** In-memory KV recording put options. */
export class FakeKV {
  readonly store = new Map<string, string>();
  readonly puts: { key: string; options: unknown }[] = [];
  readonly deletes: string[] = [];
  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string, options?: unknown): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, options });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletes.push(key);
  }
}

export const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-abc",
  redirectUri: "https://client.example/callback",
  scope: ["notes"],
  state: "state-xyz",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: `${ORIGIN}/mcp`,
  issuer: ORIGIN,
};

export interface FakeProvider {
  helpers: OAuthHelpers;
  completed: CompleteAuthorizationOptions[];
  revoked: { grantId: string; userId: string }[];
  parse: (request: Request) => Promise<AuthRequest>;
  describe: (request: AuthRequest) => Promise<ConsentDescription>;
}

export function fakeProvider(): FakeProvider {
  const fake: FakeProvider = {
    completed: [],
    revoked: [],
    parse: async () => AUTH_REQUEST,
    describe: async (request) => ({
      clientId: request.clientId,
      clientName: "Example Agent",
      redirectUri: request.redirectUri,
      redirectHost: "client.example",
      redirectIsLoopback: false,
      scope: request.scope,
    }),
    helpers: {} as OAuthHelpers,
  };
  fake.helpers = {
    parseAuthRequest: (request: Request) => fake.parse(request),
    describeConsent: (request: AuthRequest) => fake.describe(request),
    completeAuthorization: async (options: CompleteAuthorizationOptions) => {
      fake.completed.push(options);
      return { redirectTo: `${options.request.redirectUri}?code=issued&state=${options.request.state}` };
    },
    revokeGrant: async (grantId: string, userId: string) => {
      fake.revoked.push({ grantId, userId });
    },
  } as unknown as OAuthHelpers;
  return fake;
}

export function fakeEnv(kv: FakeKV, provider: FakeProvider, overrides: Partial<Env> = {}): Env {
  const assets = {
    fetch: async () =>
      new Response("<!doctype html><title>Palladian</title>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  };
  return {
    ASSETS: assets as unknown as Fetcher,
    OAUTH_KV: kv as unknown as KVNamespace,
    PUBLIC_ORIGIN: ORIGIN,
    AGENT_JWT_ISSUER: ORIGIN,
    CONVEX_URL: "https://example-123.convex.cloud",
    AGENT_JWT_PRIVATE_KEY: "",
    OAUTH_PROVIDER: provider.helpers,
    ...overrides,
  };
}
