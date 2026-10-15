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
import { MCP_PATH, publicOrigin, resourceUrl, type Env } from "./env.ts";
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

export default {
  fetch(request, env, ctx) {
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
} satisfies ExportedHandler<Env>;
