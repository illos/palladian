import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { frontendOrigin } from "./local-auth-origin.mjs";
const config = readFileSync(".env.local", "utf8");
if (
  !config.includes("CONVEX_DEPLOYMENT=anonymous:") ||
  !config.includes("http://127.0.0.1:3214") ||
  !config.includes("http://127.0.0.1:3215") ||
  Object.keys(process.env).some((k) => k.startsWith("CONVEX_"))
) {
  throw new Error(
    "Expected anonymous local 3214/3215 without deployment overrides",
  );
}
console.log(
  "target: local-anonymous 3214/3215; initialize missing auth settings only",
);
function command(args) {
  const result = spawnSync("node_modules/.bin/convex", args, {
    env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      "Local environment operation failed; sensitive output suppressed",
    );
  return result.stdout;
}
// Read into memory only; env list output may contain secrets and is never printed.
const values = new Map(
  command(["env", "list"])
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      return match ? [[match[1], match[2]]] : [];
    }),
);
const origin = values.get("SITE_URL");
if (origin && origin !== frontendOrigin)
  throw new Error("Existing frontend origin differs; refusing to change it");
if (!origin) command(["env", "set", "SITE_URL", frontendOrigin]);
if (!values.has("BETTER_AUTH_SECRET"))
  command([
    "env",
    "set",
    "BETTER_AUTH_SECRET",
    randomBytes(48).toString("base64url"),
  ]);
console.log(
  "Local auth settings are present; existing secret preserved and values suppressed.",
);
