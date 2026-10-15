import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { ConvexCallError, convexCaller, type ConvexCaller } from "./convex.ts";
import { fns } from "./convex-api.ts";
import { publicOrigin, type Env } from "./env.ts";
import { grantedScopes } from "./scopes.ts";

/**
 * The Worker side of agent consent. `/authorize` validates the OAuth request
 * and parks it in KV; the SPA's `/connect` page shows it, lets the signed-in
 * person choose notebooks and calls Convex `connections.approve`; then it posts
 * the one-time code to `/oauth/approve`, which redeems it and completes the
 * OAuth authorization. See README "Consent contract".
 */

export const REQUEST_TTL_SECONDS = 600;
const KEY_PREFIX = "connect:";
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ClientSummary {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  /** For a Client ID Metadata Document client: the verified domain of its client_id URL. */
  clientDomain: string | null;
  redirectHost: string;
  /** The redirect goes to an app on this computer; the page should warn. */
  redirectIsLoopback: boolean;
  scopes: string[];
}

export interface PendingRequest {
  oauthReqInfo: AuthRequest;
  client: ClientSummary;
  createdAt: number;
}

export interface ConsentDeps {
  /** Unauthenticated Convex client for `connections.redeem`. */
  convex?: (env: Env) => Pick<ConvexCaller, "mutation">;
  newKey?: () => string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function newRequestKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

function jsonError(error: string, status: number): Response {
  return json({ error }, status);
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A minimal page for requests that cannot safely be redirected back. */
export function errorPage(message: string, status = 400): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Palladian sign-in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
<h1>This sign-in request can't continue</h1>
<p>${escapeHtml(message)}</p>
<p>Return to the app you were connecting and start again.</p>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      ...NO_STORE,
    },
  });
}

/** GET /authorize */
export async function handleAuthorize(
  request: Request,
  env: Env,
  deps: ConsentDeps = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return errorPage("Unsupported request method.", 405);
  let oauthReqInfo: AuthRequest;
  let client: ClientSummary;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    // The client's own metadata, for the consent page. Every string here is
    // chosen by the client: the SPA must render it as text.
    const details = await env.OAUTH_PROVIDER.describeConsent(oauthReqInfo);
    const named = details.clientName && details.clientName !== details.clientId;
    client = {
      clientId: oauthReqInfo.clientId,
      clientName: named ? details.clientName : details.redirectHost,
      clientUri: details.clientUri ?? null,
      logoUri: details.logoUri ?? null,
      clientDomain: details.clientDomain ?? null,
      redirectHost: details.redirectHost,
      redirectIsLoopback: details.redirectIsLoopback,
      scopes: grantedScopes(oauthReqInfo.scope),
    };
  } catch (error) {
    // Redirect only when the library validated the client and redirect URI.
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError)
      return errorPage(error.description);
    if (error instanceof CimdFetchError)
      return errorPage("The connecting app could not be verified.");
    throw error;
  }
  const key = (deps.newKey ?? newRequestKey)();
  const pending: PendingRequest = {
    oauthReqInfo,
    client,
    createdAt: Date.now(),
  };
  await env.OAUTH_KV.put(KEY_PREFIX + key, JSON.stringify(pending), {
    expirationTtl: REQUEST_TTL_SECONDS,
  });
  const target = new URL("/connect", publicOrigin(env));
  target.searchParams.set("request", key);
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), ...NO_STORE },
  });
}

async function loadPending(env: Env, key: string) {
  if (!KEY_PATTERN.test(key)) return null;
  return env.OAUTH_KV.get<PendingRequest>(KEY_PREFIX + key, { type: "json" });
}

/** GET /oauth/request/<key> */
export async function handleRequestInfo(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method !== "GET") return jsonError("Method not allowed.", 405);
  const pending = await loadPending(env, key);
  if (!pending)
    return jsonError(
      "This sign-in request expired or was already used. Start again from your app.",
      404,
    );
  const { client } = pending;
  return json({
    clientId: client.clientId,
    clientName: client.clientName,
    clientUri: client.clientUri,
    logoUri: client.logoUri,
    clientDomain: client.clientDomain,
    redirectHost: client.redirectHost,
    redirectIsLoopback: client.redirectIsLoopback,
    scopes: client.scopes,
    expiresAt: pending.createdAt + REQUEST_TTL_SECONDS * 1000,
  });
}

/**
 * CSRF defense for the consent POSTs: JSON only (a cross-site form cannot send
 * it without a CORS preflight, which this Worker never grants), from this
 * origin, and not marked cross-site by the browser.
 */
export function crossSiteRejection(
  request: Request,
  env: Env,
): Response | null {
  if (request.method !== "POST") return jsonError("Method not allowed.", 405);
  const type = request.headers.get("Content-Type") ?? "";
  if (type.split(";")[0]!.trim().toLowerCase() !== "application/json")
    return jsonError("Send JSON.", 415);
  if (request.headers.get("Origin") !== publicOrigin(env))
    return jsonError("Cross-origin requests are not allowed.", 403);
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin")
    return jsonError("Cross-site requests are not allowed.", 403);
  return null;
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Load and delete a pending request: each key works once. */
async function takePending(env: Env, key: string) {
  const pending = await loadPending(env, key);
  if (pending) await env.OAUTH_KV.delete(KEY_PREFIX + key);
  return pending;
}

/** POST /oauth/approve { request, code } */
export async function handleApprove(
  request: Request,
  env: Env,
  deps: ConsentDeps = {},
): Promise<Response> {
  const rejected = crossSiteRejection(request, env);
  if (rejected) return rejected;
  const body = await readBody(request);
  const key = body?.request;
  const code = body?.code;
  if (typeof key !== "string" || typeof code !== "string" || code.length > 200)
    return jsonError("Expected { request, code }.", 400);
  const pending = await takePending(env, key);
  if (!pending)
    return jsonError(
      "This sign-in request expired or was already used. Start again from your app.",
      404,
    );
  const convex = (deps.convex ?? ((e: Env) => convexCaller(e.CONVEX_URL)))(env);
  let redeemed;
  try {
    redeemed = await convex.mutation(fns.connections.redeem, {
      code,
      requestKey: key,
    });
  } catch (error) {
    if (error instanceof ConvexCallError && error.failure.kind !== "uncertain")
      return jsonError(
        "This approval is no longer valid. Start again from your app.",
        400,
      );
    return jsonError(
      "Could not reach the notes service. Start again from your app.",
      502,
    );
  }
  if (redeemed.clientId !== pending.oauthReqInfo.clientId)
    return jsonError("This approval was made for a different app.", 400);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: redeemed.agentId,
    scope: grantedScopes(pending.oauthReqInfo.scope),
    metadata: { connectionId: redeemed.connectionId },
    props: { agentId: redeemed.agentId, connectionId: redeemed.connectionId },
  });
  return json({ redirectTo });
}

/** POST /oauth/deny { request } */
export async function handleDeny(
  request: Request,
  env: Env,
): Promise<Response> {
  const rejected = crossSiteRejection(request, env);
  if (rejected) return rejected;
  const body = await readBody(request);
  const key = body?.request;
  if (typeof key !== "string") return jsonError("Expected { request }.", 400);
  const pending = await takePending(env, key);
  if (!pending)
    return jsonError(
      "This sign-in request expired or was already used. Start again from your app.",
      404,
    );
  const { oauthReqInfo } = pending;
  return json({
    redirectTo: authorizationErrorRedirect(
      {
        redirectUri: oauthReqInfo.redirectUri,
        ...(oauthReqInfo.state ? { state: oauthReqInfo.state } : {}),
        ...(oauthReqInfo.issuer ? { issuer: oauthReqInfo.issuer } : {}),
      },
      "access_denied",
      "The user declined to connect this app.",
    ),
  });
}

/** GET /connect: the SPA's consent route, never framed. */
export async function handleConnect(
  request: Request,
  env: Env,
): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  response.headers.append("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  // The URL carries the request key; keep it out of Referer headers.
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
