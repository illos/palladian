// Actual 900-second JWT expiry plus the Convex verifier's five-second clock-skew tolerance; no shortened policy or fake clock.
import { frontendOrigin } from "./environment.mjs";
import {
  launchLifecycleBrowser,
  prepareSuspension,
} from "./lifecycle-browser.mjs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const env = readFileSync(".env.local", "utf8");
assert(
  env.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    env.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((k) => k.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous 3214/3215; disposable owner for real-time expired-JWT resume",
);
const user = {
  email: `resume-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "Resume fixture",
};
const result = spawnSync(
  "node_modules/.bin/convex",
  ["run", "provision:owner", JSON.stringify(user)],
  { stdio: "pipe", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
);
assert(result.status === 0, "Provisioning failed; details suppressed");
const runtime = await launchLifecycleBrowser();
try {
  const context = runtime.context;
  const page = context.pages()[0];
  let automaticToken = null;
  let observingResume = false;
  const postResumeRequests = new WeakSet();
  page.on("request", (request) => {
    if (observingResume) postResumeRequests.add(request);
  });
  page.on("response", (response) => {
    if (
      response.url().includes("/api/auth/convex/token") &&
      response.ok() &&
      (!observingResume || postResumeRequests.has(response.request()))
    ) {
      void response
        .json()
        .then((body) => {
          if (observingResume && !postResumeRequests.has(response.request()))
            return;
          if (typeof body.token === "string") automaticToken = body.token;
        })
        .catch(() => {});
    }
  });
  await page.goto(frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
  const token = automaticToken;
  assert(
    typeof token === "string",
    "Official provider must obtain the initial JWT",
  );
  let lastQueryStatus = null;
  const client = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
    fetch: async (...args) => {
      lastQueryStatus = null;
      const response = await fetch(...args);
      lastQueryStatus = response.status;
      return response;
    },
  });
  client.setAuth(token);
  const before = await client.query(api.platform.identity.current, {});
  assert(before?.id);
  let navigated = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  });
  const expires =
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp *
    1000;
  // Assert actual hidden/frozen state; standard Playwright focus emulation made
  // the previous visible-page freeze a no-op in the pinned browser.
  const suspension = await prepareSuspension(context, page);
  while (Date.now() < expires + 6000) {
    await new Promise((r) =>
      setTimeout(r, Math.min(30000, expires + 6000 - Date.now())),
    );
    console.log(
      "Waiting for real 900-second access JWT expiry; page remains frozen.",
    );
  }
  let denied = false;
  try {
    denied =
      (await client.query(api.platform.identity.current, {})) === null &&
      lastQueryStatus === 200;
  } catch {
    // A transport failure, rate limit, or server error is not auth denial.
    denied = lastQueryStatus === 401;
  }
  assert(denied, "Expired JWT must fail on real server");
  automaticToken = null;
  observingResume = true;
  await suspension.resume();
  function hasFreshToken() {
    if (typeof automaticToken !== "string" || automaticToken === token)
      return false;
    try {
      const claims = JSON.parse(
        Buffer.from(automaticToken.split(".")[1], "base64url").toString(),
      );
      return typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !hasFreshToken())
    await new Promise((r) => setTimeout(r, 500));
  console.log(
    JSON.stringify({
      expiredJwtDenied: denied,
      resumedWithoutNavigation: !navigated,
      tokenResponseObserved: automaticToken !== null,
      distinctUnexpiredTokenObserved: hasFreshToken(),
    }),
  );
  assert(!navigated, "Resume must not reload the document");
  const resumedAt = suspension.events.find(
    ({ event }) => event === "resume",
  )?.at;
  const frozenAt = suspension.events.find(
    ({ event }) => event === "freeze",
  )?.at;
  const timerAt = suspension.events.find(({ event }) => event === "timer")?.at;
  assert(typeof resumedAt === "number", "Actual resume event required");
  assert(typeof frozenAt === "number", "Actual freeze event required");
  assert(frozenAt < expires, "Document must freeze before actual JWT expiry");
  assert(
    resumedAt - frozenAt >= expires + 6000 - frozenAt,
    "Document must remain frozen through real JWT expiry and verifier tolerance",
  );
  assert(
    timerAt >= resumedAt,
    "One-second timer must run only after actual resume",
  );
  assert(
    hasFreshToken(),
    "Official provider must automatically renew on resume without a direct token demand",
  );
  client.setAuth(automaticToken);
  assert(
    (await client.query(api.platform.identity.current, {}))?.id === before.id,
  );
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  console.log(
    "PASS desktop frozen-tab resume after real JWT expiry with valid long session. Real iPhone/PWA remains pending.",
  );
} catch (error) {
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/resume.mjs:"))
      .join("\n"),
  );
  console.error("FAIL real-time resume; sensitive details suppressed");
  process.exitCode = 1;
} finally {
  await runtime.close();
}
