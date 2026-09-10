// Actual hosted-service acceptance through production browser flows. No /src
// imports, identity injection, admin session edits, or direct token acquisition.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api.js";
import {
  hostedTarget as target,
  verifyHostedTarget,
} from "./hosted-target.mjs";

let browser;
let operator;
let scenario = "dedicated target verification";
let scenarioCount = 0;
const retainedClients = [];
function pass() {
  scenarioCount++;
  console.log(`PASS hosted ${scenario}`);
}
function account(label) {
  return {
    email: `hosted-${label}-${randomBytes(10).toString("hex")}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
    name: "Hosted disposable acceptance fixture",
  };
}
function claims(token) {
  const decoded = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  assert(
    typeof decoded.exp === "number" && typeof decoded.iat === "number",
    "Expected JWT timestamps",
  );
  return decoded;
}
async function ready(page) {
  await page.getByTestId("private-account").waitFor({ timeout: 30000 });
}
function observeProvider(page) {
  let latest;
  let generation = 0;
  const requests = new WeakMap();
  page.on("request", (request) => {
    requests.set(request, generation);
  });
  page.on("response", (response) => {
    const dispatchedGeneration = requests.get(response.request());
    if (
      response.url() !== `${target.authUrl}/api/auth/convex/token` ||
      !response.ok() ||
      dispatchedGeneration !== generation
    )
      return;
    void (async () => {
      const body = await response.json();
      const credential = await response
        .request()
        .headerValue("better-auth-cookie");
      // Publish the complete pair only if this request was dispatched after
      // the latest reset. Older asynchronous captures cannot qualify a reload.
      if (typeof body.token === "string" && dispatchedGeneration === generation)
        latest = { token: body.token, credential };
    })().catch(() => {});
  });
  return {
    reset() {
      generation++;
      latest = undefined;
    },
    async credentials() {
      const deadline = Date.now() + 10000;
      while (!latest && Date.now() < deadline) {
        // A stalled response body must not bypass this bounded observer wait.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        typeof latest?.token === "string",
        "Official provider token response required",
      );
      assert.equal(claims(latest.token).exp - claims(latest.token).iat, 900);
      return latest;
    },
  };
}
async function signedIn(page, observer, user) {
  observer.reset();
  await page.goto(target.frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await ready(page);
  return authenticated(observer);
}
async function authenticated(observer) {
  const { token, credential } = await observer.credentials();
  let status;
  const client = new ConvexHttpClient(target.dataUrl, {
    logger: false,
    fetch: async (...args) => {
      status = undefined;
      const response = await fetch(...args);
      status = response.status;
      return response;
    },
  });
  client.setAuth(token);
  const identity = await client.query(api.platform.identity.current, {});
  assert(identity?.id, "Positive protected hosted identity required");
  retainedClients.push(client);
  return { client, token, credential, identity, status: () => status };
}
async function storageDigest(page) {
  return page.evaluate(async () => {
    const value = localStorage.getItem("palladian_cookie") ?? "";
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    );
  });
}
async function browserRequest(page, path, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let code = null;
      try {
        code = (await response.json()).code ?? null;
      } catch {}
      return { status: response.status, code };
    },
    { url: `${target.authUrl}/api/auth/${path}`, body },
  );
}
try {
  operator = await verifyHostedTarget();
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const expectedOrigins = new Set([
    target.frontendOrigin,
    target.authUrl,
    target.dataUrl,
  ]);
  const scriptChecks = [];
  let dataConfigured = false;
  let authConfigured = false;
  page.on("response", (response) => {
    if (
      new URL(response.url()).origin !== target.frontendOrigin ||
      !/\.js(?:\?|$)/.test(response.url())
    )
      return;
    scriptChecks.push(
      response
        .text()
        .then((text) => {
          dataConfigured ||= text.includes(target.dataUrl);
          authConfigured ||= text.includes(target.authUrl);
        })
        .catch(() => {}),
    );
  });
  await page.route("**/*", (route) =>
    expectedOrigins.has(new URL(route.request().url()).origin)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  const sessionResponse = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${target.authUrl}/api/auth/get-session`) &&
      response.ok(),
  );
  await page.goto(target.frontendOrigin);
  await page.getByLabel("Email", { exact: true }).waitFor();
  await sessionResponse;
  await Promise.all(scriptChecks);
  assert(
    dataConfigured && authConfigured,
    "Built frontend must contain both exact verified public URLs",
  );
  assert(
    await page.evaluate(() => window.isSecureContext && !!navigator.locks),
    "Secure hosted browser and Web Locks required",
  );
  pass();

  // Only now generate/provision credentials: target, origin and built config
  // were checked without submitting a credential to an unverified frontend.
  const owner = account("a");
  const other = account("b");
  operator.provision(owner);
  operator.provision(other);
  const observer = observeProvider(page);
  scenario = "public signup disabled";
  const signup = await browserRequest(page, "sign-up/email", account("public"));
  assert.equal(signup.status, 400);
  assert.equal(signup.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  pass();

  scenario = "real sign-in, persisted reload and shared-tab identity";
  const first = await signedIn(page, observer, owner);
  assert(
    await page.evaluate(
      () => localStorage.getItem("palladian_session_data") === null,
    ),
  );
  observer.reset();
  await page.reload();
  await ready(page);
  const reloaded = await authenticated(observer);
  assert.deepEqual(reloaded.identity, first.identity);
  const peer = await context.newPage();
  const peerObserver = observeProvider(peer);
  await peer.goto(target.frontendOrigin);
  await ready(peer);
  assert.deepEqual(
    (await authenticated(peerObserver)).identity,
    first.identity,
  );
  pass();

  scenario =
    "temporary startup 429/503/network faults retain credentials and recover";
  await peer.close();
  for (const fault of [429, 503, "network"]) {
    const digest = await storageDigest(page);
    const handler = (route) =>
      fault === "network"
        ? route.abort("timedout")
        : route.fulfill({
            status: fault,
            contentType: "application/json",
            body: '{"message":"Injected temporary acceptance fault"}',
          });
    await page.route(`${target.authUrl}/api/auth/**`, handler);
    await page.reload();
    await page
      .getByRole("heading", { name: "Everything in its place." })
      .waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: "Connection unavailable. Your session is retained." })
      .waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).count(), 0);
    assert.deepEqual(await storageDigest(page), digest);
    await page.unroute(`${target.authUrl}/api/auth/**`, handler);
    observer.reset();
    await page.getByRole("button", { name: "Retry connection" }).click();
    await ready(page);
    assert.deepEqual((await authenticated(observer)).identity, first.identity);
  }
  pass();

  scenario = "independent-device UI revocation denies an unexpired JWT";
  const deviceContext = await browser.newContext();
  const device = await deviceContext.newPage();
  const deviceObserver = observeProvider(device);
  const independent = await signedIn(device, deviceObserver, owner);
  assert.deepEqual(independent.identity, first.identity);
  const before = await first.client.query(api.platform.sessions.list, {
    cursor: null,
  });
  const originalSession = before.page.find((session) => session.current);
  assert(originalSession && before.isDone && before.page.length === 2);
  const deviceSessions = await independent.client.query(
    api.platform.sessions.list,
    { cursor: null },
  );
  assert(
    deviceSessions.page.some(
      (session) => session.id === originalSession.id && !session.current,
    ),
  );
  const otherRow = device
    .getByRole("region", { name: "Account" })
    .locator("div")
    .filter({ has: device.getByText(/^Other session · Created/) });
  await otherRow.getByRole("button", { name: "Revoke", exact: true }).click();
  const deadline = Date.now() + 15000;
  let denied = false;
  while (Date.now() < deadline) {
    denied =
      (await first.client.query(api.platform.identity.current, {})) === null &&
      first.status() === 200;
    if (denied) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    claims(first.token).exp > Date.now() / 1000,
    "Revocation must precede JWT expiry",
  );
  assert(denied, "Live server session revocation must deny protected data");
  assert.deepEqual(
    await independent.client.query(api.platform.identity.current, {}),
    first.identity,
  );
  pass();

  scenario = "account switch and cross-account revoke denied";
  const deviceOwned = (
    await independent.client.query(api.platform.sessions.list, { cursor: null })
  ).page.find((session) => session.current);
  assert(deviceOwned);
  await page.reload();
  const b = await signedIn(page, observer, other);
  assert.notDeepEqual(b.identity, first.identity);
  let crossAccountDenied = false;
  try {
    await b.client.action(api.platform.sessions.revoke, { id: deviceOwned.id });
  } catch (error) {
    crossAccountDenied =
      error instanceof ConvexError && error.data === "NOT_FOUND";
  }
  assert(
    crossAccountDenied,
    "Cross-account ownership denial must be a server function result",
  );
  assert.deepEqual(
    await independent.client.query(api.platform.identity.current, {}),
    first.identity,
  );
  const visibleB = await b.client.query(api.platform.sessions.list, {
    cursor: null,
  });
  assert(visibleB.page.every((session) => session.id !== deviceOwned.id));
  pass();

  scenario =
    "hostile HTTPS-origin credentialed preflight blocked with session preserved";
  assert(
    typeof b.credential === "string" && b.credential.length > 0,
    "Capture official request credential in memory for hostile-origin test",
  );
  const hostile = await browser.newPage();
  const hostileOrigin = "https://palladian-hostile.example.invalid";
  await hostile.route(`${hostileOrigin}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Hostile origin fixture</title>",
    }),
  );
  await hostile.goto(hostileOrigin);
  // Playwright intercepts OPTIONS itself while any page route is active,
  // synthesizing permissive CORS. Disable fixture routing before the actual
  // hosted-origin request so its preflight reaches the real auth service.
  await hostile.unrouteAll({ behavior: "wait" });
  let preflightSeen = false;
  hostile.on("request", (request) => {
    if (
      request.url() === `${target.authUrl}/api/auth/sign-out` &&
      request.method() === "OPTIONS"
    )
      preflightSeen = true;
  });
  const blocked = await hostile.evaluate(
    async ({ authUrl, credential }) => {
      try {
        await fetch(`${authUrl}/api/auth/sign-out`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Better-Auth-Cookie": credential,
          },
          credentials: "omit",
          body: "{}",
        });
        return false;
      } catch {
        return true;
      }
    },
    { authUrl: target.authUrl, credential: b.credential },
  );
  assert(blocked, "Actual browser cross-origin request must be blocked");
  assert.deepEqual(
    await b.client.query(api.platform.identity.current, {}),
    b.identity,
  );
  // Playwright does not consistently expose browser-internal preflight as a
  // request event; exact CORS headers are checked independently below.
  const cors = await fetch(`${target.authUrl}/api/auth/sign-out`, {
    method: "OPTIONS",
    headers: {
      origin: hostileOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,better-auth-cookie",
    },
    redirect: "error",
  });
  assert(
    (cors.status >= 200 && cors.status < 300) || cors.status === 403,
    "A transport/server failure is not CORS-denial evidence",
  );
  assert.notEqual(
    cors.headers.get("access-control-allow-origin"),
    hostileOrigin,
  );
  assert.notEqual(cors.headers.get("access-control-allow-origin"), "*");
  console.log(
    JSON.stringify({
      browserPreflightEventObserved: preflightSeen,
      hostileBrowserRequestBlocked: blocked,
    }),
  );
  await hostile.close();
  pass();

  scenario = "hostile callback rejected and unused OTT disabled";
  const callback = await browserRequest(page, "sign-in/email", {
    ...other,
    callbackURL: "https://attacker.invalid/callback",
  });
  assert.deepEqual(callback, { status: 403, code: "INVALID_CALLBACK_URL" });
  const ott = await browserRequest(page, "cross-domain/one-time-token/verify", {
    token: "synthetic-not-a-credential",
  });
  assert.equal(ott.status, 404);
  assert.deepEqual(
    await b.client.query(api.platform.identity.current, {}),
    b.identity,
  );
  pass();

  scenario =
    "explicit signout clears private UI and revokes its hosted session";
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("private-account").count(), 0);
  assert.equal(await b.client.query(api.platform.identity.current, {}), null);
  await device.getByRole("button", { name: "Sign out", exact: true }).click();
  await device.getByLabel("Email", { exact: true }).waitFor();
  assert.equal(
    await independent.client.query(api.platform.identity.current, {}),
    null,
  );
  pass();
  console.log(
    `Completed ${scenarioCount} hosted checks. Temporary faults were deliberately intercepted; positive auth, persistence, revocation, CORS and callbacks used actual services. Real900s hosted resume, sliding/expiry edge cases, real iPhone/PWA, recovery and full release acceptance remain pending.`,
  );
} catch {
  console.error(
    `FAIL hosted ${scenario}; details suppressed to protect credentials and private data.`,
  );
  process.exitCode = 1;
} finally {
  // Restrict best-effort cleanup to sessions visible to our captured fixture
  // identities. Never delete users, tables, deployment data or infrastructure.
  for (const client of retainedClients) {
    try {
      const sessions = await client.query(api.platform.sessions.list, {
        cursor: null,
      });
      const current = sessions.page.find((session) => session.current);
      if (current)
        await client.action(api.platform.sessions.revoke, { id: current.id });
    } catch {}
  }
  operator?.close();
  await browser?.close();
}
