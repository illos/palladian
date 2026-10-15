#!/usr/bin/env node
// End-to-end check of the palladian Worker against real services:
// a running `wrangler dev` (default http://localhost:8787) and a local Convex
// backend for apps/notes-backend. See README "End-to-end check".
//
// Prints only non-secret progress. Creates a disposable account each run.
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../notes-backend/convex/_generated/api.js";

const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";
const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3228";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3229";
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "http://localhost:5178";
const BACKEND_DIR =
  process.env.NOTES_BACKEND_DIR ??
  new URL("../../notes-backend", import.meta.url).pathname;
const REDIRECT_URI = "http://127.0.0.1:43219/callback";

let step = 0;
function log(message) {
  console.log(`[e2e ${String(++step).padStart(2, "0")}] ${message}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const quiet = { logger: false };

// --- 1. A disposable person, signed in through Better Auth ---------------------

async function createPerson() {
  const email = `e2e-${randomBytes(6).toString("hex")}@example.test`;
  const password = b64url(randomBytes(24));
  const { stdout } = await promisify(execFile)(
    "npx",
    ["convex", "run", "provision:setupOwner", JSON.stringify({ email })],
    { cwd: BACKEND_DIR, env: process.env, maxBuffer: 1 << 20 },
  );
  const json = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  const { token } = JSON.parse(json);
  assert(typeof token === "string", "setupOwner returned a token");
  const anonymous = new ConvexHttpClient(CONVEX_URL, quiet);
  await anonymous.action(api.invitations.accept, {
    token,
    name: "E2E Person",
    password,
  });
  log("created a disposable account from a setup invitation");

  // The crossDomain plugin returns the session cookie in Set-Better-Auth-Cookie
  // when the request carries a Better-Auth-Cookie header.
  const signIn = await fetch(`${CONVEX_SITE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE_ORIGIN,
      "Better-Auth-Cookie": "",
    },
    body: JSON.stringify({ email, password }),
  });
  assert(signIn.ok, `sign-in succeeded (HTTP ${signIn.status})`);
  const setCookie = signIn.headers.get("set-better-auth-cookie");
  assert(setCookie, "sign-in returned Set-Better-Auth-Cookie");
  const cookie = setCookie
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((part) => part.split(";")[0].trim())
    .join("; ");
  const tokenResponse = await fetch(
    `${CONVEX_SITE_URL}/api/auth/convex/token`,
    {
      headers: { Origin: SITE_ORIGIN, "Better-Auth-Cookie": cookie },
    },
  );
  assert(
    tokenResponse.ok,
    `Convex token issued (HTTP ${tokenResponse.status})`,
  );
  const { token: jwt } = await tokenResponse.json();
  const human = new ConvexHttpClient(CONVEX_URL, quiet);
  human.setAuth(jwt);
  log("signed in through Better Auth and obtained a Convex JWT");
  return human;
}

// --- 2. OAuth against the Worker ---------------------------------------------

async function form(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: await response.json() };
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(WORKER + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: WORKER,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function connectAgent(
  human,
  notebookId,
  { clientName = "E2E Agent", agentId } = {},
) {
  const challenge = await fetch(`${WORKER}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert(challenge.status === 401, "unauthenticated /mcp is challenged");
  const wwwAuth = challenge.headers.get("www-authenticate") ?? "";
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  assert(prmUrl, "challenge names resource_metadata");
  const prm = await (await fetch(prmUrl)).json();
  assert(
    prm.resource === `${WORKER}/mcp`,
    "protected resource metadata names /mcp",
  );
  const issuer = prm.authorization_servers[0];
  const as = await (
    await fetch(`${issuer}/.well-known/oauth-authorization-server`)
  ).json();
  assert(
    as.issuer === issuer && as.registration_endpoint,
    "authorization server metadata with DCR",
  );
  log(
    `discovery: 401 challenge → ${new URL(prmUrl).pathname} → issuer ${issuer} (scope ${prm.scopes_supported.join(" ")})`,
  );

  const registration = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert(registration.status === 201, "dynamic client registration");
  const { client_id: clientId } = await registration.json();
  log("registered a public client with DCR");

  const verifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authorize = new URL(as.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    scope: "notes offline_access",
    resource: prm.resource,
  }).toString();
  const redirect = await fetch(authorize, { redirect: "manual" });
  assert(redirect.status === 302, "authorize redirects to the consent page");
  const connectUrl = new URL(redirect.headers.get("location"));
  assert(connectUrl.pathname === "/connect", "consent page is /connect");
  const key = connectUrl.searchParams.get("request");
  // The browser-binding cookie the consent page's requests must carry.
  const browser = (redirect.headers.get("set-cookie") ?? "").split(";")[0];
  assert(
    browser.startsWith("__Host-"),
    "authorize binds the request to this browser",
  );
  const page = await fetch(connectUrl, { headers: { Cookie: browser } });
  assert(
    page.status === 200 &&
      page.headers.get("x-frame-options") === "DENY" &&
      (page.headers.get("content-security-policy") ?? "").includes(
        "frame-ancestors 'none'",
      ),
    "consent page served unframeable",
  );
  const elsewhere = await fetch(`${WORKER}/oauth/request/${key}`);
  assert(elsewhere.status === 403, "another browser cannot open the request");
  const info = await (
    await fetch(`${WORKER}/oauth/request/${key}`, {
      headers: { Cookie: browser },
    })
  ).json();
  assert(
    info.clientId === clientId && info.clientName === clientName,
    "request info names the client",
  );
  log(
    `authorize (PKCE S256) → /connect; request info: ${info.clientName} → ${info.redirectHost}, scopes ${info.scopes.join(" ")}`,
  );

  const approval = await human.mutation(api.connections.approve, {
    requestKey: key,
    clientId: info.clientId,
    clientName: info.clientName,
    redirectHost: info.redirectHost,
    agentName: "E2E Agent",
    // A different app reusing an agent must be an explicit transfer.
    ...(agentId ? { agentId, transfer: true } : {}),
    notebooks: [{ notebookId, role: "edit" }],
    autoShareRole: null,
  });
  log(
    agentId
      ? "the person approved a second connection for the same agent in Convex"
      : "the person approved in Convex, sharing their default notebook with edit access",
  );

  const crossSite = await postJson(
    "/oauth/approve",
    { request: key, code: approval.code },
    {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
      Cookie: browser,
    },
  );
  assert(crossSite.status === 403, "cross-site approve is refused");
  const otherBrowser = await postJson("/oauth/approve", {
    request: key,
    code: approval.code,
  });
  assert(
    otherBrowser.status === 403,
    "approve from another browser is refused",
  );
  const approved = await postJson(
    "/oauth/approve",
    { request: key, code: approval.code },
    { Cookie: browser },
  );
  assert(
    approved.status === 200 && approved.body.redirectTo,
    "approve returns redirectTo",
  );
  const reused = await postJson(
    "/oauth/approve",
    { request: key, code: approval.code },
    { Cookie: browser },
  );
  assert(reused.status === 404, "a request key works once");
  const callback = new URL(approved.body.redirectTo);
  assert(
    callback.origin + callback.pathname === REDIRECT_URI,
    "redirect goes to the registered URI",
  );
  assert(callback.searchParams.get("state") === state, "state round-trips");
  assert(callback.searchParams.get("iss") === issuer, "RFC 9207 iss present");
  const code = callback.searchParams.get("code");
  log(
    "approve: cross-site and other-browser attempts refused (403), redirect captured, key reuse refused (404)",
  );

  const exchanged = await form(as.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: prm.resource,
  });
  assert(
    exchanged.status === 200 &&
      exchanged.body.access_token &&
      exchanged.body.refresh_token,
    "code exchange",
  );
  assert(exchanged.body.expires_in === 3600, "access tokens last one hour");
  log(
    `token exchange: access token (expires_in ${exchanged.body.expires_in}s, scope "${exchanged.body.scope}") and refresh token`,
  );

  const refreshed = await form(as.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
  });
  assert(
    refreshed.status === 200 && refreshed.body.access_token,
    "refresh exchange",
  );
  log("refresh-token exchange issued a new access token");
  return {
    agentId: approval.agentId,
    accessToken: refreshed.body.access_token,
    refreshToken: refreshed.body.refresh_token,
    clientId,
    tokenEndpoint: as.token_endpoint,
  };
}

// --- 3. MCP with the official client SDK -------------------------------------

function recordingFetch(record) {
  return async (input, init) => {
    const response = await fetch(input, init);
    record.push({
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
    });
    return response;
  };
}

async function mcpClient(accessToken, mode, record = []) {
  const client = new Client(
    { name: "palladian-e2e", version: "1.0.0" },
    mode === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : {},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${WORKER}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      fetch: recordingFetch(record),
    },
  );
  await client.connect(transport);
  return client;
}

function text(result) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${text(result)}`);
  return result;
}

async function exerciseTools(client, privateNoteId) {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert(names.length === 12, `12 tools listed (${names.join(", ")})`);
  assert(
    tools.every(
      (t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean",
    ),
    "tools are annotated",
  );
  log(
    `modern client (${client.getNegotiatedProtocolVersion()}, era ${client.getProtocolEra()}): ${names.length} tools`,
  );

  const notebooks = await call(client, "list_notebooks");
  const shared = notebooks.structuredContent.notebooks;
  assert(
    shared.length === 1 && shared[0].role === "edit",
    "only the shared notebook is visible, with edit access",
  );

  const marker = `zephyr${randomBytes(4).toString("hex")}`;
  const markdown = `E2E conversation ${marker}\n\nWe discussed the ${marker} plan.\n\n- [ ] buy milk\n- [ ] call the plumber`;
  const requestId = randomUUID();
  const created = await call(client, "create_note", {
    markdown,
    request_id: requestId,
  });
  const noteId = created.structuredContent.note_id;
  assert(
    created.structuredContent.title === `E2E conversation ${marker}`,
    "first line became the title",
  );
  const replay = await call(client, "create_note", {
    markdown,
    request_id: requestId,
  });
  assert(
    replay.structuredContent.replayed &&
      replay.structuredContent.note_id === noteId,
    "request_id replay returns the same note",
  );
  log(
    "create_note from Markdown, and its request_id replay returned the same note",
  );

  const found = await call(client, "search_notes", { query: marker });
  assert(
    found.structuredContent.results.some((r) => r.note_id === noteId),
    "search finds the note",
  );
  const listed = await call(client, "list_notes", { limit: 5 });
  assert(
    listed.structuredContent.notes.some((n) => n.note_id === noteId),
    "list_notes shows the note",
  );
  log("search_notes and list_notes found it");

  const asMarkdown = await call(client, "read_note", { note_id: noteId });
  assert(
    asMarkdown.structuredContent.markdown.includes("- [ ] buy milk"),
    "markdown read",
  );
  const outline = await call(client, "read_note", {
    note_id: noteId,
    format: "outline",
  });
  const milk = outline.structuredContent.outline.find(
    (b) => b.markdown.includes("buy milk") && b.checked === false,
  );
  assert(milk, "outline lists the checklist item with its checked state");
  log(
    `read_note as markdown (revision ${asMarkdown.structuredContent.revision}) and as outline (${outline.structuredContent.outline.length} blocks)`,
  );

  const edited = await call(client, "edit_note", {
    note_id: noteId,
    edits: [
      {
        type: "replace_text",
        old_text: `the ${marker} plan`,
        new_text: `the revised ${marker} plan`,
      },
    ],
    request_id: randomUUID(),
  });
  const checked = await call(client, "edit_note", {
    note_id: noteId,
    edits: [{ type: "set_checked", block_id: milk.id, checked: true }],
    expected_revision: edited.structuredContent.revision,
    request_id: randomUUID(),
  });
  const after = await call(client, "read_note", {
    note_id: noteId,
    format: "outline",
  });
  assert(
    after.structuredContent.outline.some(
      (b) => b.id === milk.id && b.checked === true,
    ),
    "item is checked",
  );
  assert(
    after.structuredContent.outline.some((b) =>
      b.markdown.includes(`revised ${marker}`),
    ),
    "text replaced",
  );
  log(
    `edit_note replace_text and set_checked → revision ${checked.structuredContent.revision}`,
  );

  const history = await call(client, "note_history", { note_id: noteId });
  assert(
    history.structuredContent.versions.length >= 1,
    "history lists revisions",
  );
  const original = await call(client, "read_revision", {
    note_id: noteId,
    revision: 0,
  });
  assert(
    original.structuredContent.markdown.includes(`the ${marker} plan`),
    "revision 0 has the original text",
  );
  log(
    `note_history (${history.structuredContent.versions.length} entries) and read_revision 0`,
  );

  const hidden = await call(client, "search_notes", {
    query: "unsharedsecret",
  });
  assert(
    hidden.structuredContent.results.length === 0,
    "unshared notebook content is not searchable",
  );
  const denied = await client.callTool({
    name: "read_note",
    arguments: { note_id: privateNoteId },
  });
  assert(
    denied.isError && /not_found/.test(text(denied)),
    "unshared note reads as not found",
  );
  log(
    "an unshared notebook's note is invisible to search and read (not_found)",
  );

  const bad = await client.callTool({
    name: "read_note",
    arguments: { note_id: "not-a-real-id" },
  });
  assert(bad.isError, "a malformed note id is a tool error");
  return noteId;
}

// --- 4. Revocation -------------------------------------------------------------

async function rawToolCall(accessToken) {
  const response = await fetch(`${WORKER}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_notebooks", arguments: {} },
    }),
  });
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("www-authenticate") ?? "",
  };
}

async function main() {
  log(`worker ${WORKER}, convex ${CONVEX_URL}`);
  const human = await createPerson();
  const notebooks = await human.query(api.library.notebooks, {});
  const defaultNotebook = notebooks.find((n) => n.isDefault);
  assert(defaultNotebook, "the new account has a default notebook");
  const privateNotebook = await human.mutation(api.notebooks.create, {
    name: "Private",
    description: "Not shared",
  });
  const privateNote = await human.mutation(api.notes.createFromMarkdown, {
    notebookId: privateNotebook,
    markdown: "Private plans\n\nunsharedsecret details",
  });
  log(
    "the person has a default notebook and an unshared 'Private' notebook with a note",
  );

  const agent = await connectAgent(human, defaultNotebook.id);

  const modern = await mcpClient(agent.accessToken, "modern");
  assert(modern.getProtocolEra() === "modern", "modern era negotiated");
  await exerciseTools(modern, privateNote.noteId);
  await modern.close();

  const legacy = await mcpClient(agent.accessToken, "legacy");
  assert(legacy.getProtocolEra() === "legacy", "legacy era negotiated");
  const legacyTools = await legacy.listTools();
  const legacyNotebooks = await call(legacy, "list_notebooks");
  assert(
    legacyTools.tools.length === 12 &&
      legacyNotebooks.structuredContent.notebooks.length === 1,
    "legacy client works",
  );
  log(
    `2025-era client (${legacy.getNegotiatedProtocolVersion()}, stateless fallback): tools/list and list_notebooks`,
  );
  await legacy.close();

  // A second connection for the same agent (another client), to check revocation
  // on both protocol paths while each grant is still valid at the OAuth layer.
  const second = await connectAgent(human, defaultNotebook.id, {
    clientName: "E2E Second Client",
    agentId: agent.agentId,
  });
  assert(
    second.agentId === agent.agentId,
    "the second connection reuses the agent",
  );

  const connections =
    (await human.query(api.connections.mine, {})).find(
      (a) => a.agentId === agent.agentId,
    )?.connections ?? [];
  assert(connections.length === 2, "two connections recorded for the agent");
  for (const connection of connections)
    await human.mutation(api.connections.revoke, {
      connectionId: connection.id,
    });
  log("the person revoked both connections in Convex");

  for (const [mode, tokens, tool] of [
    ["modern", agent, "list_notebooks"],
    ["legacy", second, "search_notes"],
  ]) {
    const record = [];
    const client = await mcpClient(tokens.accessToken, mode, record);
    let failed = false;
    try {
      await client.callTool({
        name: tool,
        arguments: tool === "search_notes" ? { query: "plan" } : {},
      });
    } catch {
      failed = true;
    }
    const last = record.at(-1);
    assert(
      failed &&
        last?.status === 401 &&
        /error="invalid_token"/.test(last.wwwAuthenticate ?? ""),
      `${mode} ${tool} after revocation is HTTP 401 invalid_token`,
    );
    assert(
      /resource_metadata="/.test(last.wwwAuthenticate),
      "the 401 names resource_metadata",
    );
    await client.close().catch(() => {});
    log(
      `${mode} client: ${tool} after revocation → HTTP 401, WWW-Authenticate error="invalid_token"`,
    );
  }

  const raw = await rawToolCall(agent.accessToken);
  assert(
    raw.status === 401 && raw.wwwAuthenticate.includes('error="invalid_token"'),
    "later calls stay 401",
  );
  for (const tokens of [agent, second]) {
    const refresh = await form(tokens.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
    assert(
      refresh.status === 400 && refresh.body.error === "invalid_grant",
      "refresh fails after revocation, forcing re-authorization",
    );
  }
  log(
    "later calls stay 401 and refresh answers invalid_grant, so clients must sign in again",
  );
  log("PASS");
}

main().catch((error) => {
  console.error(
    `[e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
