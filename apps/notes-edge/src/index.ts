import {
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
  handleApprove,
  handleAuthorize,
  handleConnect,
  handleDeny,
  handleRequestInfo,
} from "./consent.ts";
import { D1KV, purgeAbandonedClients, reserveRegistration } from "./d1-kv.ts";
import { EMAIL_RELAY_PATH, handleEmailRelay } from "./email.ts";
import {
  MCP_PATH,
  publicOrigin,
  resourceUrl,
  type DeployedEnv,
  type Env,
} from "./env.ts";
import { handleMcp, type McpContext } from "./mcp/handler.ts";
import { REQUIRED_SCOPES, SCOPES_SUPPORTED } from "./scopes.ts";

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Routes the OAuth provider does not own (it serves metadata, token and registration). */
async function routeDefault(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/authorize") return handleAuthorize(request, env);
  if (pathname.startsWith("/oauth/request/"))
    return handleRequestInfo(
      request,
      env,
      pathname.slice("/oauth/request/".length),
    );
  if (pathname === "/oauth/approve") return handleApprove(request, env);
  if (pathname === "/oauth/deny") return handleDeny(request, env);
  if (pathname === "/connect") return handleConnect(request, env);
  if (pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/"))
    return notFound();
  // Only run_worker_first paths reach the Worker in production; serve anything else as the SPA.
  return env.ASSETS.fetch(request);
}

/**
 * Connections last until the person revokes them: refresh tokens and
 * dynamically registered clients never expire. Rotation keeps the previous
 * refresh token valid until its replacement is used, so a lost response never
 * strands a client. The library reads an explicit `undefined` as "no expiry"
 * (omitting the option means 30 and 90 days), but its declarations do not admit
 * `undefined` under exactOptionalPropertyTypes, hence the separate assignment.
 */
const NEVER_EXPIRE = {
  refreshTokenTTL: undefined,
  clientRegistrationTTL: undefined,
};

export function providerOptions(origin: string): OAuthProviderOptions<Env> {
  const options: OAuthProviderOptions<Env> = {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: (request, env, ctx) => handleMcp(request, env, ctx as McpContext),
    },
    defaultHandler: {
      fetch: (request, env) => routeDefault(request as Request, env),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    scopesSupported: SCOPES_SUPPORTED,
    requiredScopes: REQUIRED_SCOPES,
    resourceMetadata: {
      resource: resourceUrl(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Palladian notes",
    },
    onError: ({ code, status, internal }) => {
      // Never log request bodies, tokens or client metadata.
      console.warn("OAuth error", {
        code,
        status,
        category: internal.category,
        reason: internal.reason,
      });
    },
  };
  return Object.assign(options, NEVER_EXPIRE);
}

export function createProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>(providerOptions(origin));
}

/**
 * Discovery aliases for clients that guess metadata locations instead of
 * following RFC 9728 path insertion: the protected resource document at the
 * root, and authorization server metadata with the resource path appended.
 */
const DISCOVERY_ALIASES: Record<string, string> = {
  "/.well-known/oauth-protected-resource":
    "/.well-known/oauth-protected-resource" + MCP_PATH,
  ["/.well-known/oauth-authorization-server" + MCP_PATH]:
    "/.well-known/oauth-authorization-server",
};

let cached: { origin: string; provider: OAuthProvider<Env> } | undefined;

/** Present one OAUTH_KV interface whichever storage binding is deployed. */
export function withOAuthStorage(deployed: DeployedEnv): Env {
  if (deployed.OAUTH_KV) return deployed as Env;
  if (!deployed.OAUTH_DB)
    throw new Error("Bind OAUTH_KV or OAUTH_DB for OAuth storage.");
  // D1KV implements the KV subset the provider and consent handoff use.
  const store = new D1KV(deployed.OAUTH_DB) as unknown as KVNamespace;
  return { ...deployed, OAUTH_KV: store } as Env;
}

/** Hard ceiling on new anonymous registrations per hour across the Worker. */
const REGISTRATIONS_PER_HOUR = 300;

/**
 * Bound anonymous registrations: a per-address limit slows bursts (Cloudflare's
 * limiter is approximate), and an atomic hourly reservation in D1 bounds storage
 * together with the daily purge. Connected clients are unaffected.
 */
async function registrationAllowed(request: Request, deployed: DeployedEnv) {
  if (request.method !== "POST") return true;
  if (deployed.REGISTRATION_LIMIT) {
    const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await deployed.REGISTRATION_LIMIT.limit({ key })).success)
      return false;
  }
  if (deployed.OAUTH_DB)
    return reserveRegistration(deployed.OAUTH_DB, REGISTRATIONS_PER_HOUR);
  return true;
}

export default {
  async fetch(request, deployed, ctx) {
    if (new URL(request.url).pathname === EMAIL_RELAY_PATH)
      return handleEmailRelay(request, deployed);
    if (
      new URL(request.url).pathname === "/oauth/register" &&
      !(await registrationAllowed(request, deployed))
    )
      return new Response(
        JSON.stringify({
          error: "slow_down",
          error_description:
            "Too many client registrations. Try again shortly.",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        },
      );
    const env = withOAuthStorage(deployed);
    const origin = publicOrigin(env);
    if (cached?.origin !== origin)
      cached = { origin, provider: createProvider(origin) };
    const url = new URL(request.url);
    const alias = DISCOVERY_ALIASES[url.pathname];
    if (alias && (request.method === "GET" || request.method === "HEAD")) {
      url.pathname = alias;
      return cached.provider.fetch(new Request(url, request), env, ctx);
    }
    return cached.provider.fetch(request, env, ctx);
  },
  async scheduled(_controller, deployed, ctx) {
    if (deployed.OAUTH_DB)
      ctx.waitUntil(purgeAbandonedClients(deployed.OAUTH_DB));
  },
} satisfies ExportedHandler<DeployedEnv>;
