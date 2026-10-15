#!/usr/bin/env node
// Full-stack browser check: the Worker serves the app, an OAuth client signs in
// through the real /connect consent page, uses MCP, and the person disconnects
// it from Settings. Needs `wrangler dev` on :8787 serving a build of apps/notes
// configured for the local Convex backend, whose SITE_URL is the Worker origin.
// Prints only non-secret progress.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const require = createRequire(
  new URL("../../notes/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";
const BACKEND_DIR =
  process.env.NOTES_BACKEND_DIR ??
  new URL("../../notes-backend", import.meta.url).pathname;
const REDIRECT_URI = "http://127.0.0.1:43221/callback";
const b64url = (value) => Buffer.from(value).toString("base64url");
let n = 0;
const step = (message) =>
  console.log(`[browser ${String(++n).padStart(2, "0")}] ${message}`);

async function setupLink(email) {
  const { stdout } = await promisify(execFile)(
    "npx",
    ["convex", "run", "provision:setupOwner", JSON.stringify({ email })],
    { cwd: BACKEND_DIR, maxBuffer: 1 << 20 },
  );
  const { token } = JSON.parse(
    stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
  );
  return `${WORKER}/invite#${token}`;
}

async function mcp(accessToken) {
  const client = new Client({ name: "browser-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(WORKER + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `consent-${randomBytes(4).toString("hex")}@example.test`;
  const password = b64url(randomBytes(18));
  await page.goto(await setupLink(email));
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(WORKER + "/", { timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: "New notebook" }).first(),
  ).toBeAttached({ timeout: 20_000 });
  step("account created and signed in on the Worker-served app");

  // An MCP client registers and starts OAuth in this browser.
  const registration = await fetch(`${WORKER}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Consent Test Agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }).then((r) => r.json());
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authorize = new URL(WORKER + "/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "notes offline_access",
    resource: WORKER + "/mcp",
  }).toString();
  const redirected = page.waitForRequest(
    (request) => request.url().startsWith(REDIRECT_URI),
    { timeout: 30_000 },
  );
  await page.goto(authorize.toString());
  await page.waitForURL(/\/connect\?request=/);
  await expect(
    page.getByRole("heading", { name: "Connect Consent Test Agent" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Access to Notes")).toHaveValue("edit");
  step(
    "consent page shows the client and defaults the default notebook to edit",
  );
  await page.getByRole("button", { name: "Allow" }).click();
  const callback = new URL((await redirected).url());
  if (callback.searchParams.get("state") !== state)
    throw new Error("state mismatch");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("no code in redirect");
  step("Allow redirected back to the client with an authorization code");

  const tokens = await fetch(`${WORKER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: registration.client_id,
      code_verifier: verifier,
      resource: WORKER + "/mcp",
    }),
  }).then((r) => r.json());
  if (!tokens.access_token) throw new Error("token exchange failed");
  const client = await mcp(tokens.access_token);
  const created = await client.callTool({
    name: "create_note",
    arguments: {
      markdown: "# Written by an agent\n\nThrough the consent page.",
      request_id: "browser-e2e-1",
    },
  });
  if (created.isError) throw new Error("create_note failed");
  step("the agent created a note over MCP");
  // Allow sent the browser to the client's redirect; return to the app.
  await page.goto(WORKER + "/");
  await expect(
    page.getByRole("button", { name: /Written by an agent/ }),
  ).toBeVisible({ timeout: 15_000 });
  step("the note appeared live in the person's library");

  await page
    .getByRole("button", { name: "Settings", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Connected agents" }).click();
  await expect(
    page.getByRole("heading", { name: "Consent Test Agent" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).first().click();
  await expect(page.getByText("Disconnected")).toBeVisible({ timeout: 10_000 });
  const after = await fetch(`${WORKER}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
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
  if (after.status !== 401)
    throw new Error(`expected 401 after disconnect, got ${after.status}`);
  step("Disconnect in Settings made the agent's next call fail with 401");
  console.log("PASS");
} finally {
  await browser.close();
}
