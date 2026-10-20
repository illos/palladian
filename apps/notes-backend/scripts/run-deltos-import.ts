/**
 * Operator CLI for the one-off Deltos import (D100–D101). Each step stops
 * with a nonzero exit unless its gate passes; output is counts, Deltos IDs
 * and fixed labels only. CONVEX_DEPLOYMENT selects the project; --prod
 * targets its production deployment.
 *
 *   node apps/notes-backend/scripts/run-deltos-import.ts <step> \
 *     --file <export.jsonl> --owner <email> [--prod]
 *
 * Steps, in order: stage (staging must be empty; appends the export),
 * check (dry run), import (check, import in batches, verify), verify, clear
 * (verify again, then empty staging and confirm). Delete the export file
 * after a successful clear.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  clear,
  runImport,
  stagingEmpty,
  verify,
  type ImportBackend,
  type Outcome,
} from "./deltos-runner.ts";

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEPS = ["stage", "check", "import", "verify", "clear"] as const;
type Step = (typeof STEPS)[number];

class Stop extends Error {}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Stop(`--${name} is required`);
  return value;
}

/** The exported Deltos IDs only; the rest of each line is not read further. */
function exportedIds(file: string) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Stop("The export file cannot be read.");
  }
  const ids = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const row: unknown = JSON.parse(line);
        if (
          typeof row === "object" &&
          row !== null &&
          "deltosId" in row &&
          typeof row.deltosId === "string"
        )
          return row.deltosId;
      } catch {
        // Fall through to the fixed message.
      }
      throw new Stop("The export file has a line that is not an export row.");
    });
  if (new Set(ids).size !== ids.length)
    throw new Stop("The export file repeats a Deltos ID.");
  return ids;
}

function convex(prod: boolean, args: string[]) {
  try {
    return execFileSync(
      "npx",
      ["convex", args[0]!, ...(prod ? ["--prod"] : []), ...args.slice(1)],
      {
        cwd: backendDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // Never echo the captured streams; report the step and exit status only.
    const status =
      typeof error === "object" && error && "status" in error
        ? String(error.status)
        : "unknown";
    throw new Stop(
      `convex ${args[0]} ${args[1] ?? ""} failed (exit ${status})`,
    );
  }
}

function backend(prod: boolean): ImportBackend {
  const call = async (name: string, args: object) => {
    const stdout = convex(prod, [
      "run",
      `imports:${name}`,
      JSON.stringify(args),
    ]);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Stop(`imports:${name} returned output that is not JSON`);
    }
  };
  return {
    check: (args) => call("checkDeltos", args),
    importBatch: (args) => call("importDeltos", args),
    verify: (args) => call("verifyDeltos", args),
    imported: (args) => call("importedDeltos", args),
    clear: (args) => call("clearDeltos", args),
  };
}

async function main(): Promise<Outcome> {
  const step = process.argv[2] as Step;
  if (!STEPS.includes(step))
    throw new Stop(`step must be one of ${STEPS.join(", ")}`);
  if (!process.env.CONVEX_DEPLOYMENT)
    throw new Stop("CONVEX_DEPLOYMENT is required");
  const prod = process.argv.includes("--prod");
  const file = option("file");
  const owner = option("owner");
  const expected = exportedIds(file);
  const api = backend(prod);
  switch (step) {
    case "stage": {
      if (!(await stagingEmpty(api, owner)))
        throw new Stop("Staging is not empty; clear it before staging again.");
      convex(prod, [
        "import",
        "--table",
        "deltosImports",
        "--append",
        "-y",
        file,
      ]);
      const checked = await check(api, expected);
      return {
        ...checked,
        summary: { exported: expected.length, ...checked.summary },
      };
    }
    case "check":
      return check(api, expected);
    case "import":
      return runImport(api, owner, expected);
    case "verify":
      return verify(api, owner, expected);
    case "clear":
      return clear(api, owner, expected);
  }
}

main().then(
  (outcome) => {
    console.log(JSON.stringify(outcome, null, 2));
    process.exitCode = outcome.ok ? 0 : 1;
  },
  (error: unknown) => {
    console.error(error instanceof Stop ? error.message : "The step failed.");
    process.exitCode = 1;
  },
);
