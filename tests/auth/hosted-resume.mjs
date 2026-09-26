// Actual hosted 900-second expiry. No local guard changes, request interception,
// fake clock, reduced policy, provider invocation, or imperative browser token demand.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import {
  hostedTarget as target,
  verifyHostedTarget,
} from "./hosted-target.mjs";
import {
  launchLifecycleBrowser,
  prepareSuspension,
} from "./lifecycle-browser.mjs";

const expectedRuntimeCommit = "14c01341de205f5014c50156261d0415c72b0793";
const expectedAssetDigest =
  "3e938be94b5fa8c10ed03e5afc24d4d0402b4a3a5ee157dcf93b3e3944b57060";

async function verifyPublishedAssets() {
  const root = join(target.checkout, ".wrangler/palladian-development/assets");
  const identity = JSON.parse(
    await readFile(
      join(target.checkout, ".wrangler/palladian-development/identity.json"),
      "utf8",
    ),
  );
  assert.equal(identity.runtimeCommit, expectedRuntimeCommit);
  assert.equal(identity.assetDigest, expectedAssetDigest);
  async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await files(path)));
      else result.push(path);
    }
    return result;
  }
  const aggregate = createHash("sha256");
  let publishedFiles = 0;
  for (const path of (await files(root)).sort()) {
    const relative = path.slice(root.length);
    const local = await readFile(path);
    aggregate.update(relative).update(local);
    // The internal Vite manifest is intentionally not a served asset.
    if (relative.split("/").some((part) => part.startsWith("."))) continue;
    const response = await fetch(
      `${target.frontendOrigin}${relative === "/index.html" ? "/" : relative}`,
      { redirect: "error", signal: AbortSignal.timeout(20000) },
    );
    assert(response.ok, "Pinned hosted asset unavailable");
    const remote = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash("sha256").update(remote).digest("hex"),
      createHash("sha256").update(local).digest("hex"),
      "Hosted asset changed from the independently reviewed runtime",
    );
    publishedFiles++;
  }
  assert.equal(aggregate.digest("hex"), expectedAssetDigest);
  assert.equal(publishedFiles, 9);
}

function claims(token) {
  const value = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  assert(typeof value.exp === "number" && typeof value.iat === "number");
  assert.equal(value.exp - value.iat, 900);
  return value;
}

let operator;
let runtime;
let scenario = "verify exact hosted target and immutable published assets";
try {
  operator = await verifyHostedTarget();
  await verifyPublishedAssets();
  runtime = await launchLifecycleBrowser();
  const page = runtime.context.pages()[0];
  let observedToken = null;
  let observingResume = false;
  const postResumeRequests = new WeakSet();
  page.on("request", (request) => {
    if (observingResume) postResumeRequests.add(request);
  });
  page.on("response", (response) => {
    if (
      response.url() !== `${target.authUrl}/api/auth/convex/token` ||
      !response.ok() ||
      (observingResume && !postResumeRequests.has(response.request()))
    )
      return;
    void response
      .json()
      .then((body) => {
        if (observingResume && !postResumeRequests.has(response.request()))
          return;
        if (typeof body.token === "string") observedToken = body.token;
      })
      .catch(() => {});
  });
  await page.goto(target.frontendOrigin);
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert(
    await page.evaluate(() => window.isSecureContext && !!navigator.locks),
  );

  scenario = "provision disposable dev fixture and establish positive identity";
  const user = {
    email: `hosted-resume-${randomBytes(10).toString("hex")}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
    name: "Hosted disposable resume fixture",
  };
  operator.provision(user);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 30000 });
  const initialDeadline = Date.now() + 5000;
  while (observedToken === null && Date.now() < initialDeadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const initialToken = observedToken;
  assert(typeof initialToken === "string", "Official initial JWT required");
  const expiresAt = claims(initialToken).exp * 1000;
  let lastQueryStatus = null;
  const client = new ConvexHttpClient(target.dataUrl, {
    logger: false,
    fetch: async (...args) => {
      lastQueryStatus = null;
      const response = await fetch(...args);
      lastQueryStatus = response.status;
      return response;
    },
  });
  client.setAuth(initialToken);
  const before = await client.query(api.platform.identity.current, {});
  assert(before?.id && lastQueryStatus === 200);
  let navigated = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  });

  scenario = "actual hosted browser suspension through real JWT expiry";
  const suspension = await prepareSuspension(runtime.context, page);
  const frozenAt = suspension.events.find(
    ({ event }) => event === "freeze",
  )?.at;
  assert(typeof frozenAt === "number" && frozenAt < expiresAt);
  console.log(
    "Hosted document genuinely frozen; waiting for real 900-second JWT expiry.",
  );
  while (Date.now() < expiresAt + 6000) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(30000, expiresAt + 6000 - Date.now())),
    );
    assert(
      !suspension.events.some(
        ({ event }) => event === "timer" || event === "resume",
      ),
      "Browser must remain suspended for the entire expiry interval",
    );
    console.log(
      "Waiting for actual hosted JWT expiry; browser remains frozen.",
    );
  }
  let denied = false;
  try {
    denied =
      (await client.query(api.platform.identity.current, {})) === null &&
      lastQueryStatus === 200;
  } catch {
    denied = lastQueryStatus === 401;
  }
  assert(
    denied,
    "Expired JWT must receive actual hosted authentication denial",
  );

  scenario = "automatic hosted provider renewal after actual thaw";
  observedToken = null;
  observingResume = true;
  const thawStartedAt = Date.now();
  await suspension.resume();
  function freshToken() {
    if (typeof observedToken !== "string" || observedToken === initialToken)
      return false;
    try {
      return claims(observedToken).exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }
  const deadline = thawStartedAt + 30000;
  while (!freshToken() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const resumedAt = suspension.events.find(
    ({ event }) => event === "resume",
  )?.at;
  const timerAt = suspension.events.find(({ event }) => event === "timer")?.at;
  assert(typeof resumedAt === "number" && resumedAt >= expiresAt + 6000);
  assert(timerAt >= resumedAt, "Timer must execute only after actual resume");
  assert(!navigated, "Hosted resume must not navigate or reload");
  assert(
    freshToken(),
    "Official provider must automatically obtain a distinct valid JWT",
  );
  const renewalObservedMs = Date.now() - thawStartedAt;
  client.setAuth(observedToken);
  assert.deepEqual(
    await client.query(api.platform.identity.current, {}),
    before,
  );
  await page.getByTestId("private-account").waitFor({ timeout: 30000 });
  await verifyPublishedAssets();

  scenario = "fixture signout and revoked-session confirmation";
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert.equal(await client.query(api.platform.identity.current, {}), null);
  console.log(
    JSON.stringify({
      actualHostedServices: true,
      frozenForMs: resumedAt - frozenAt,
      expiredJwtDenied: denied,
      timerSuppressedUntilResume: true,
      resumedWithoutNavigation: !navigated,
      distinctUnexpiredPostThawToken: true,
      renewalObservedMs,
      sameProtectedIdentityAndPrivateUi: true,
      immutableHostedAssets: true,
      fixtureSessionRevoked: true,
    }),
  );
  console.log(
    "PASS actual hosted 900-second expiry/resume. Real iPhone/PWA and other pending phase evidence remain pending.",
  );
} catch {
  console.error(
    `FAIL hosted resume: ${scenario}; sensitive details suppressed.`,
  );
  process.exitCode = 1;
} finally {
  operator?.close();
  await runtime?.close();
}
