import { chromium } from "@playwright/test";
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
  "target: local-anonymous 3214/3215; fixture for production-build timing and redacted export",
);
const user = {
  email: `timing-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "Timing fixture",
};
const r = spawnSync(
  "node_modules/.bin/convex",
  ["run", "provision:owner", JSON.stringify(user)],
  { stdio: "pipe", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
);
assert(r.status === 0, "Provision failed; details suppressed");
const browser = await chromium.launch();
try {
  const original = await browser.newContext();
  const first = await original.newPage();
  await first.goto("http://localhost:5173");
  await first.getByLabel("Email", { exact: true }).fill(user.email);
  await first.getByLabel("Password", { exact: true }).fill(user.password);
  await first.getByRole("button", { name: "Sign in", exact: true }).click();
  await first.getByTestId("private-account").waitFor({ timeout: 20000 });
  const state = await original.storageState(); // In memory only; never serialized to a file or log.
  async function measure(page) {
    await page
      .getByRole("heading", { name: "Everything in its place." })
      .waitFor();
    await page.getByTestId("private-account").waitFor({ timeout: 20000 });
    return page.evaluate(() => ({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      bootstrapFrame:
        performance.getEntriesByName("palladian-shell")[0]?.startTime,
      data: performance.getEntriesByName("palladian-authenticated-data")[0]
        ?.startTime,
    }));
  }
  const cold = [],
    warm = [];
  for (let i = 0; i < 6; i++) {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    await page.goto("http://localhost:5173");
    cold.push(await measure(page));
    await page.reload();
    warm.push(await measure(page));
    await context.close();
  }
  assert([...cold, ...warm].every((t) => t.fcp > 0 && t.data > t.fcp));
  function stats(runs, key) {
    const values = runs.map((r) => r[key]).sort((a, b) => a - b);
    return { median: (values[2] + values[3]) / 2, p95: values[5] };
  }
  console.log(
    JSON.stringify({
      browser: browser.version(),
      conditions:
        "Linux headless, production Vite preview over loopback, no throttling, persisted credential copied in memory; cold=new context HTTP cache, warm=reload",
      cold,
      warm,
      summary: {
        cold: { fcp: stats(cold, "fcp"), data: stats(cold, "data") },
        warm: { fcp: stats(warm, "fcp"), data: stats(warm, "data") },
      },
    }),
  );
  const downloadPromise = first.waitForEvent("download");
  await first
    .getByRole("button", { name: "Export redacted diagnostics" })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let contents = "";
  for await (const chunk of stream) contents += chunk.toString();
  const parsed = JSON.parse(contents);
  assert.deepEqual(Object.keys(parsed).sort(), ["events", "version"]);
  const allowed = new Set([
    "resolving",
    "ready",
    "temporary",
    "sign_in_needed",
    "logout",
    "account_change",
  ]);
  assert(
    parsed.events.every(
      (e) =>
        Object.keys(e).sort().join(",") === "code,milliseconds" &&
        allowed.has(e.code) &&
        typeof e.milliseconds === "number",
    ),
  );
  await download.delete();
  await first.getByRole("button", { name: "Sign out", exact: true }).click();
  console.log(
    "PASS separate production FCP/authenticated data timings and allowlisted diagnostic export; no phone performance claim",
  );
} catch (error) {
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/performance.mjs:"))
      .join("\n"),
  );
  console.error("FAIL production timing/export; private details suppressed");
  process.exitCode = 1;
} finally {
  await browser.close();
}
