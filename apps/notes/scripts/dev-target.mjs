// Shared guard for real-service e2e scripts: they run only against one Convex
// development deployment, and everything they touch must agree on it: the
// Convex CLI that provisions accounts (which reads the environment and the
// backend's .env.local and .env, with deploy keys taking precedence over
// CONVEX_DEPLOYMENT), the scripts' own HTTP calls, and the app under test.
// Every check runs before anything is provisioned. Errors name the problem,
// never a value.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Variables that would point the Convex CLI at another deployment or host. */
export const OVERRIDES = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
  "CONVEX_PROVISION_HOST",
  "CONVEX_PROD",
];

/** The only Convex variables a script's environment may set. */
const REQUIRED = ["CONVEX_DEPLOYMENT", "CONVEX_SITE_URL", "CONVEX_CLOUD_URL"];

/** A dotenv file's variables (the subset of the format the CLI's files use). */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const quoted = /^(["'])(.*)\1$/.exec(match[2]);
    vars[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, "");
  }
  return vars;
}

/**
 * The development deployment everything must use, from the environment and
 * the backend's env files. Throws if anything could point elsewhere.
 */
export function devTarget(env, files = {}) {
  const problems = [];
  for (const [name, value] of Object.entries(env))
    if (name.startsWith("CONVEX_") && !REQUIRED.includes(name) && value)
      problems.push(`${name} is set in the environment`);
  const match = /^dev:([a-z0-9]+(?:-[a-z0-9]+)+)$/.exec(
    env.CONVEX_DEPLOYMENT ?? "",
  );
  if (!match) problems.push("CONVEX_DEPLOYMENT must be dev:<deployment name>");
  const name = match?.[1];
  const site = name ? `https://${name}.convex.site` : null;
  const cloud = name ? `https://${name}.convex.cloud` : null;
  if (name && env.CONVEX_SITE_URL !== site)
    problems.push(`CONVEX_SITE_URL must be ${site}`);
  if (name && env.CONVEX_CLOUD_URL !== cloud)
    problems.push(`CONVEX_CLOUD_URL must be ${cloud}`);
  // The CLI reads these files too; they may repeat the target, nothing else.
  const expected = {
    CONVEX_DEPLOYMENT: env.CONVEX_DEPLOYMENT,
    CONVEX_URL: cloud,
    CONVEX_CLOUD_URL: cloud,
    CONVEX_SITE_URL: site,
  };
  for (const [file, vars] of Object.entries(files))
    for (const [key, value] of Object.entries(vars)) {
      if (!key.startsWith("CONVEX_")) continue;
      if (OVERRIDES.includes(key) || !(key in expected))
        problems.push(`${key} is set in ${file}`);
      else if (value !== expected[key])
        problems.push(`${file} sets a different ${key}`);
    }
  if (problems.length)
    throw new Error(
      `Refusing to run anywhere but one Convex development deployment: ${problems.join("; ")}.`,
    );
  return { name, deployment: env.CONVEX_DEPLOYMENT, site, cloud };
}

/** The backend directory's env files, as the Convex CLI would read them. */
export function readEnvFiles(backendDir) {
  const files = {};
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = readFileSync(join(backendDir, file), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Could not read ${file} in the backend directory.`);
    }
    files[file] = parseEnvFile(text);
  }
  return files;
}

/** The deployment the Convex CLI acts on from `backendDir`, as it reports it. */
export function cliDeployment(backendDir, env) {
  const result = spawnSync("npx", ["convex", "dashboard", "--no-open"], {
    cwd: backendDir,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /dashboard\.convex\.dev\/d\/([a-z0-9-]+)/.exec(out)?.[1] ?? null;
}

/**
 * The Convex hosts the app at `appUrl` talks to, read from a fresh page's
 * network traffic: its Convex WebSocket and its auth requests.
 */
export async function appEndpoints(browser, appUrl, target, timeout = 20_000) {
  const cloudHost = new URL(target.cloud).host;
  const siteHost = new URL(target.site).host;
  const hosts = new Set();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const seen = (url) => {
      try {
        const host = new URL(url).host;
        if (/\.convex\.(cloud|site)$/.test(host)) hosts.add(host);
      } catch {
        // Not a URL with a host; nothing to check.
      }
    };
    page.on("websocket", (socket) => seen(socket.url()));
    page.on("request", (request) => seen(request.url()));
    await page.goto(appUrl);
    const deadline = Date.now() + timeout;
    while (
      !(hosts.has(cloudHost) && hosts.has(siteHost)) &&
      Date.now() < deadline
    )
      await page.waitForTimeout(250);
  } finally {
    await context.close();
  }
  return [...hosts];
}

/**
 * Every check, before anything is provisioned: the environment and env
 * files, the CLI's effective deployment, and the app's actual endpoints.
 */
export async function assertDevTarget({ env, backendDir, browser, appUrl }) {
  const target = devTarget(env, readEnvFiles(backendDir));
  const cli = cliDeployment(backendDir, env);
  if (cli !== target.name)
    throw new Error(
      cli
        ? `The Convex CLI would act on ${cli}, not ${target.name}.`
        : "Could not confirm which deployment the Convex CLI would act on.",
    );
  const hosts = await appEndpoints(browser, appUrl, target);
  const expected = [new URL(target.cloud).host, new URL(target.site).host];
  const strangers = hosts.filter((host) => !expected.includes(host));
  const missing = expected.filter((host) => !hosts.includes(host));
  if (strangers.length || missing.length)
    throw new Error(
      `The app under test is not using only ${target.name}: ${[
        ...strangers.map((host) => `it talks to ${host}`),
        ...missing.map((host) => `it never reached ${host}`),
      ].join("; ")}.`,
    );
  return target;
}
