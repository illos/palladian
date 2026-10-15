import { describe, expect, it } from "vitest";
import worker, { providerOptions } from "../src/index.ts";
import { grantedScopes } from "../src/scopes.ts";
import { fakeEnv, fakeProvider, FakeKV, ORIGIN } from "./fakes.ts";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("OAuth provider configuration", () => {
  it("issues hour-long access tokens and never-expiring refresh tokens and registrations", () => {
    const options = providerOptions(ORIGIN);
    expect(options.accessTokenTTL).toBe(3600);
    // Explicit undefined (not omission) is the library's "no expiry".
    expect(Object.hasOwn(options, "refreshTokenTTL")).toBe(true);
    expect(options.refreshTokenTTL).toBeUndefined();
    expect(Object.hasOwn(options, "clientRegistrationTTL")).toBe(true);
    expect(options.clientRegistrationTTL).toBeUndefined();
    expect(options.clientIdMetadataDocumentEnabled).toBe(true);
    expect(options.clientRegistrationEndpoint).toBe("/oauth/register");
    expect(options.resourceMetadata.resource).toBe(`${ORIGIN}/mcp`);
    expect(options.scopesSupported).toEqual(["notes", "offline_access"]);
    expect(options.requiredScopes).toEqual(["notes"]);
  });

  it("grants notes whatever was requested", () => {
    expect(grantedScopes([])).toEqual(["notes"]);
    expect(grantedScopes(["notes"])).toEqual(["notes"]);
    expect(grantedScopes(["offline_access"])).toEqual([
      "notes",
      "offline_access",
    ]);
    expect(grantedScopes(["openid", "profile"])).toEqual(["notes"]);
  });
});

describe("discovery", () => {
  const env = () => fakeEnv(new FakeKV(), fakeProvider());

  it("publishes protected resource metadata, also at the root alias", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await worker.fetch(
        new Request(ORIGIN + path) as never,
        env(),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["notes"],
      });
    }
  });

  it("publishes authorization server metadata with DCR and CIMD", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
    ]) {
      const response = await worker.fetch(
        new Request(ORIGIN + path) as never,
        env(),
        ctx,
      );
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
  });

  it("challenges unauthenticated MCP requests toward the metadata", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }) as never,
      env(),
      ctx,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="notes"`,
    );
  });

  it("refuses a malformed PUBLIC_ORIGIN", async () => {
    const bad = fakeEnv(new FakeKV(), fakeProvider(), {
      PUBLIC_ORIGIN: "http://palladian.example/",
    });
    expect(() =>
      worker.fetch(new Request(`${ORIGIN}/mcp`) as never, bad, ctx),
    ).toThrow(/PUBLIC_ORIGIN/);
  });
});
