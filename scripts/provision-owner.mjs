import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// P1 operator utility is intentionally local-only. Production provisioning needs its own task/runbook.
const config = readFileSync(".env.local", "utf8");
if (
  !config.includes("CONVEX_DEPLOYMENT=anonymous:") ||
  !config.includes("http://127.0.0.1:3214") ||
  Object.keys(process.env).some((k) => k.startsWith("CONVEX_"))
) {
  throw new Error(
    "Expected isolated anonymous local deployment without overrides",
  );
}
const {
  PALLADIAN_OWNER_EMAIL: email,
  PALLADIAN_OWNER_PASSWORD: password,
  PALLADIAN_OWNER_NAME: name,
} = process.env;
if (!email || !password || !name)
  throw new Error("Owner environment inputs are missing");
console.log(
  "target: local-anonymous 3214/3215; provisioning private development owner",
);
const result = spawnSync(
  "node_modules/.bin/convex",
  ["run", "provision:owner", JSON.stringify({ email, password, name })],
  { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
);
console.log(
  result.status === 0
    ? "Owner provision request completed; existing accounts are not overwritten."
    : "Provisioning failed; sensitive CLI output suppressed.",
);
process.exitCode = result.status ?? 1;
