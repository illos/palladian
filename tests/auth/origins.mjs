import { frontendOrigin } from "./environment.mjs";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const config = readFileSync(".env.local", "utf8");
assert(
  config.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    config.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((k) => k.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous 3214/3215; fixture for browser-origin checks",
);
const user = {
  email: `origin-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "Origin fixture",
};
const r = spawnSync(
  "node_modules/.bin/convex",
  ["run", "provision:owner", JSON.stringify(user)],
  { stdio: "pipe", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
);
assert(r.status === 0, "Provision failed; details suppressed");
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>Untrusted origin fixture</title>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object");
const hostileOrigin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
  const cookie = await page.evaluate(async () =>
    (await import("/src/auth/client.ts")).authClient.getCookie(),
  );
  const hostile = await browser.newPage();
  await hostile.goto(hostileOrigin);
  const blocked = await hostile.evaluate(async (cookie) => {
    try {
      await fetch("http://127.0.0.1:3215/api/auth/sign-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Better-Auth-Cookie": cookie,
        },
        body: "{}",
        credentials: "omit",
      });
      return false;
    } catch {
      return true;
    }
  }, cookie);
  assert(blocked, "Unregistered browser origin must fail preflight");
  assert(
    await page.evaluate(
      async () =>
        !!(await (await import("/src/auth/client.ts")).authClient.getSession())
          .data,
    ),
  );
  console.log(
    "PASS registered authenticated origin and hostile credentialed preflight blocked; session preserved",
  );
  const ott = await fetch(
    "http://127.0.0.1:3215/api/auth/cross-domain/one-time-token/verify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: frontendOrigin,
      },
      body: '{"token":"not-a-credential"}',
    },
  );
  assert(ott.status === 404);
  console.log("PASS unused OTT endpoint disabled");
  const callbackRejected = await page.evaluate(async (user) => {
    const response = await (
      await import("/src/auth/client.ts")
    ).authClient.signIn.email({
      ...user,
      callbackURL: "https://attacker.invalid/callback",
    });
    return (
      response.error?.status === 403 &&
      response.error?.code === "INVALID_CALLBACK_URL"
    );
  }, user);
  assert(callbackRejected);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  console.log(
    "PASS registered authenticated browser, hostile credentialed preflight blocked with session preserved, hostile callback rejected, unused OTT endpoint disabled",
  );
} catch (error) {
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/origins.mjs:"))
      .join("\n"),
  );
  console.error("FAIL origin checks; details suppressed");
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
