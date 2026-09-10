import { frontendOrigin } from "../auth/environment.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
const env = readFileSync(".env.local", "utf8");
assert(
  env.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    env.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((key) => key.startsWith("CONVEX_")));
console.log("target: local-anonymous3214/3215; disposable P2 browser fixtures");
const owner = {
  email: `p2-ui-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "P2 UI fixture",
};
const provision = spawnSync(
  "node_modules/.bin/convex",
  ["run", "provision:owner", JSON.stringify(owner)],
  { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
);
if (provision.status !== 0)
  throw Error("Fixture provisioning failed; output suppressed");
const browser = await chromium.launch();
let scenario = "startup";
const clients = [];
async function login(page) {
  await page.goto(frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("region", { name: "Workspace", exact: true }).waitFor();
  const token = await page.evaluate(
    async () =>
      (await (await import("/src/auth/client.ts")).authClient.convex.token())
        .data?.token,
  );
  assert(typeof token === "string", "Token acquisition");
  const client = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  client.setAuth(token);
  clients.push(client);
  return client;
}
try {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  const client = await login(a);
  await login(b);
  scenario = "workspace theme reconciles across browser contexts";
  await a.getByLabel("Workspace theme", { exact: true }).selectOption("dark");
  await a
    .getByRole("button", { name: "Save workspace theme", exact: true })
    .click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  await b.reload();
  await expect(
    b.getByRole("region", { name: "Workspace", exact: true }),
  ).toBeVisible();
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  console.log(`PASS ${scenario}`);
  scenario = "create and realtime instance listing";
  await a.getByLabel("New instance name", { exact: true }).fill("Shared notes");
  await a.getByRole("button", { name: "Create instance", exact: true }).click();
  const editorA = a.getByTestId("instance-editor");
  const editorB = b.getByTestId("instance-editor");
  await expect(editorA).toHaveCount(1);
  await expect(editorB).toHaveCount(1);
  await expect(
    editorB.getByRole("heading", { name: "Shared notes", exact: true }),
  ).toBeVisible();
  console.log(`PASS ${scenario}`);
  scenario =
    "D05 stale structured form retains input and explicit reload resolves";
  await editorB
    .getByLabel("Instance name", { exact: true })
    .fill("Unsaved second browser draft");
  await editorA
    .getByLabel("Instance name", { exact: true })
    .fill("First browser saved name");
  await editorA.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    editorA.getByRole("status").filter({ hasText: "Name saved." }),
  ).toBeVisible();
  await expect(
    editorB.getByRole("heading", {
      name: "First browser saved name",
      exact: true,
    }),
  ).toBeVisible();
  await editorB.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    editorB.getByRole("status").filter({ hasText: "This changed elsewhere." }),
  ).toBeVisible();
  await expect(
    editorB.getByLabel("Instance name", { exact: true }),
  ).toHaveValue("Unsaved second browser draft");
  const workspace = await client.query(api.platform.workspaces.current, {});
  const listed = await client.query(api.platform.instances.list, {
    workspaceId: workspace.id,
    lifecycle: "active",
    cursor: null,
  });
  assert.equal(listed.items[0].title, "First browser saved name");
  await editorB
    .getByRole("button", { name: "Load latest version", exact: true })
    .click();
  await expect(
    editorB.getByLabel("Instance name", { exact: true }),
  ).toHaveValue("First browser saved name");
  await editorB
    .getByLabel("Instance name", { exact: true })
    .fill("Resolved name");
  await editorB.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    editorA.getByRole("heading", { name: "Resolved name", exact: true }),
  ).toBeVisible();
  console.log(`PASS ${scenario}`);
  scenario = "scoped preference conflict retains local selection";
  await editorB.getByLabel("Instance density").selectOption("comfortable");
  await editorA.getByLabel("Instance density").selectOption("compact");
  await editorA
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    editorA.getByRole("status").filter({ hasText: "Preferences saved." }),
  ).toBeVisible();
  await editorB
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    editorB.getByRole("status").filter({ hasText: "This changed elsewhere." }),
  ).toBeVisible();
  await expect(editorB.getByLabel("Instance density")).toHaveValue(
    "comfortable",
  );
  await editorB
    .getByRole("button", { name: "Load latest preferences", exact: true })
    .click();
  await expect(editorB.getByLabel("Instance density")).toHaveValue("compact");
  console.log(`PASS ${scenario}`);
  scenario = "integrated and standalone canonical route identity";
  const instance = listed.items[0];
  await editorA
    .getByRole("link", { name: "Open standalone", exact: true })
    .click();
  await expect(a).toHaveURL(new RegExp(`/a/${instance.id}/$`));
  await expect(
    a
      .getByTestId("instance-editor")
      .getByRole("heading", { name: "Resolved name", exact: true }),
  ).toBeVisible();
  await a
    .getByTestId("instance-editor")
    .getByRole("link", { name: "Open in workspace", exact: true })
    .click();
  await expect(a).toHaveURL(
    new RegExp(`/w/${workspace.id}/a/${instance.id}/$`),
  );
  await expect(
    a
      .getByTestId("instance-editor")
      .getByRole("heading", { name: "Resolved name", exact: true }),
  ).toBeVisible();
  console.log(`PASS ${scenario}`);
  scenario = "archive closes active routes and private UI clears on logout";
  await a
    .getByTestId("instance-editor")
    .getByRole("button", { name: "Archive instance", exact: true })
    .click();
  await expect(
    a.getByRole("alert").filter({ hasText: "This instance is unavailable." }),
  ).toBeVisible();
  await expect(editorB).toHaveCount(0);
  await b.getByLabel("Show instances").selectOption("archived");
  await expect(editorB).toHaveCount(1);
  await expect(
    editorB.getByRole("button", { name: "Save name", exact: true }),
  ).toBeDisabled();
  await b.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(b.getByTestId("private-account")).toHaveCount(0);
  await a.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(a.getByTestId("private-account")).toHaveCount(0);
  console.log(`PASS ${scenario}`);
  console.log(
    "Completed 6 actual Chromium/local-service P2 UI groups; no mocks or physical-device claim.",
  );
} catch (error) {
  const locations =
    typeof error?.stack === "string"
      ? error.stack.match(/tests\/platform\/ui\.mjs:\d+:\d+/g)
      : null;
  if (locations) console.error([...new Set(locations)].join("\n"));
  console.error(`FAIL ${scenario}; private details suppressed.`);
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    try {
      const sessions = await client.query(api.platform.sessions.list, {
        cursor: null,
      });
      const current = sessions.page.find((session) => session.current);
      if (current)
        await client.action(api.platform.sessions.revoke, { id: current.id });
    } catch {
      /* Already revoked or unavailable. */
    }
  }
  await browser.close();
}
