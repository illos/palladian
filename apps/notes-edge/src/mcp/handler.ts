import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { convexCaller, type ConvexCaller } from "../convex.ts";
import {
  isAgentProps,
  publicOrigin,
  resourceMetadataUrl,
  type AgentProps,
  type Env,
} from "../env.ts";
import { storeObject, type FilesDeps } from "../files.ts";
import { mintAgentJwt } from "../jwt.ts";
import { REQUIRED_SCOPES } from "../scopes.ts";
import { createNotesServer } from "./tools.ts";

/** Same bound as the SDK's default, applied before we parse the body ourselves. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type McpContext = ExecutionContext & {
  props?: unknown;
  auth?: OAuthResourceAuth;
};

export interface McpDeps {
  /** Convex client for this agent; tests substitute a fake. */
  convex?: (env: Env, props: AgentProps) => Promise<ConvexCaller>;
  /** The file service's Convex client, for attach_file; tests substitute a fake. */
  files?: FilesDeps;
}

async function agentConvex(env: Env, props: AgentProps): Promise<ConvexCaller> {
  const jwt = await mintAgentJwt({
    privateKey: env.AGENT_JWT_PRIVATE_KEY,
    issuer: env.AGENT_JWT_ISSUER,
    agentId: props.agentId,
    connectionId: props.connectionId,
  });
  return convexCaller(env.CONVEX_URL, { auth: jwt });
}

/**
 * The 401 an MCP client re-authorizes on, in the same form the OAuth provider
 * uses for missing or expired tokens.
 */
export function invalidTokenResponse(
  origin: string,
  description: string,
): Response {
  const challenge = [
    'Bearer realm="OAuth"',
    `resource_metadata="${resourceMetadataUrl(origin)}"`,
    'error="invalid_token"',
    `scope="${REQUIRED_SCOPES.join(" ")}"`,
    `error_description="${description}"`,
  ].join(", ");
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: description }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge,
      },
    },
  );
}

function containsToolCall(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "tools/call",
  );
}

/**
 * End the OAuth grant behind a token Convex no longer accepts, so the client's
 * refresh fails and it starts a fresh authorization instead of looping.
 */
async function revokeGrant(
  env: Env,
  auth: OAuthResourceAuth | undefined,
  props: AgentProps,
) {
  const grantId = auth?.token.split(":")[1];
  if (!grantId) return;
  try {
    await env.OAUTH_PROVIDER.revokeGrant(grantId, props.agentId);
  } catch (error) {
    console.warn("Could not revoke the OAuth grant of a revoked connection", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * `/mcp`: the OAuth provider has validated the bearer token and put the grant's
 * props on `ctx.props`. Each request gets a fresh, stateless MCP server: the
 * 2026-07-28 protocol, plus the SDK's stateless fallback for 2025-era clients.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: McpContext,
  deps: McpDeps = {},
): Promise<Response> {
  const origin = publicOrigin(env);
  const props = ctx.props;
  if (!isAgentProps(props))
    return invalidTokenResponse(origin, "Unknown connection");

  let revoked = false;
  let convex: Promise<ConvexCaller> | undefined;
  const makeConvex = deps.convex ?? agentConvex;
  const files = env.FILES;
  const handler = createMcpHandler(
    () =>
      createNotesServer({
        origin,
        convex: () => (convex ??= makeConvex(env, props)),
        onRevoked: () => {
          revoked = true;
        },
        ...(files
          ? {
              storeFile: (
                objectId: string,
                ticket: string,
                bytes: Uint8Array,
              ) =>
                storeObject(
                  { ...env, FILES: files },
                  objectId,
                  ticket,
                  async (max) => (bytes.byteLength <= max ? bytes : null),
                  deps.files,
                ),
            }
          : {}),
      }),
    {
      onerror: (error) =>
        console.warn("MCP request error", {
          name: error.name,
          message: error.message,
        }),
    },
  );

  // Read the body once so tool calls can be recognised; the SDK reuses it.
  let forward = request;
  let parsedBody: unknown;
  let toolCall = false;
  if (request.method === "POST") {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body too large." },
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    try {
      parsedBody = JSON.parse(text);
      toolCall = containsToolCall(parsedBody);
    } catch {
      parsedBody = undefined;
    }
    forward = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: text,
      signal: request.signal,
    });
  }

  const response = await handler.fetch(
    forward,
    parsedBody === undefined ? undefined : { parsedBody },
  );
  if (!toolCall) return response;
  // A tool call's exchange ends with its result, so buffering is bounded. It
  // lets a revoked connection become an HTTP 401 instead of a tool error.
  const body = await response.arrayBuffer();
  if (revoked) {
    await revokeGrant(env, ctx.auth, props);
    return invalidTokenResponse(
      origin,
      "This connection was revoked or disabled",
    );
  }
  return new Response(body, response);
}
