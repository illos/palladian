import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Bindings and configuration of the `palladian` Worker (see wrangler.jsonc). */
export interface Env {
  ASSETS: Fetcher;
  /** OAuth storage: KV, or the D1-backed equivalent when only D1 is bound. */
  OAUTH_KV: KVNamespace;
  /** Exact public origin, e.g. `https://palladian.example.workers.dev`. */
  PUBLIC_ORIGIN: string;
  /** Issuer of agent JWTs; Convex's AGENT_JWT_ISSUER must be identical. */
  AGENT_JWT_ISSUER: string;
  /** Convex deployment URL (`*.convex.cloud`, or the local backend). */
  CONVEX_URL: string;
  /** Secret: private ES256 JWK as a JSON string. */
  AGENT_JWT_PRIVATE_KEY: string;
  /** Injected by OAuthProvider before either handler runs. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Bindings as deployed: either a KV namespace or a D1 database for OAuth storage. */
export type DeployedEnv = Omit<Env, "OAUTH_KV" | "OAUTH_PROVIDER"> & {
  OAUTH_KV?: KVNamespace;
  OAUTH_DB?: D1Database;
  /** Per-address limit on anonymous client registration. */
  REGISTRATION_LIMIT?: RateLimit;
  /** Account email (src/email.ts); without all three the relay answers 503. */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_RELAY_SECRET?: string;
};

/** What `completeAuthorization()` stores and every MCP request receives. */
export interface AgentProps {
  agentId: string;
  connectionId: string;
}

export function isAgentProps(value: unknown): value is AgentProps {
  if (typeof value !== "object" || value === null) return false;
  const { agentId, connectionId } = value as Record<string, unknown>;
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    typeof connectionId === "string" &&
    connectionId.length > 0
  );
}

/**
 * The configured public origin, validated: an exact origin, HTTPS except on a
 * loopback host for `wrangler dev`. OAuth resource and issuer identifiers are
 * built from it, so a malformed value must fail loudly.
 */
export function publicOrigin(env: Pick<Env, "PUBLIC_ORIGIN">): string {
  const value = env.PUBLIC_ORIGIN;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN is not a valid URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.origin !== value ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin.");
  return value;
}

export const MCP_PATH = "/mcp";

export function resourceUrl(origin: string): string {
  return origin + MCP_PATH;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function noteUrl(origin: string, noteId: string): string {
  return `${origin}/notes/${noteId}`;
}
