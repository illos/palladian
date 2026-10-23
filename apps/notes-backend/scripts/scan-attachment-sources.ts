/**
 * Read-only pre-deployment scan for B2's stricter image sources (review
 * finding F7). Pages `files:scanAttachmentSources` over current content,
 * checkpoints and the step log, and reports notes whose stored data has an
 * image source starting with `attachment:` that is not exactly an object
 * reference. Output is note IDs, revisions and counts, never content.
 * CONVEX_DEPLOYMENT selects the project; --prod targets its production
 * deployment. Writes nothing.
 *
 *   node apps/notes-backend/scripts/scan-attachment-sources.ts [--prod]
 *
 * Such sources stay readable and editable after deployment (stored
 * documents tolerate them; they name no object and show as unavailable).
 * New content cannot use them. Exit status 0 either way; read the summary.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.argv.includes("--prod");
const TABLES = ["noteContent", "noteCheckpoints", "noteSteps"] as const;

interface Page {
  scanned: number;
  loose: { noteId: string; revision: number | null; sources: number }[];
  continueCursor: string;
  isDone: boolean;
}

function page(table: string, cursor: string | null): Page {
  const stdout = execFileSync(
    "npx",
    [
      "convex",
      "run",
      ...(prod ? ["--prod"] : []),
      "files:scanAttachmentSources",
      JSON.stringify({ table, cursor, numItems: 100 }),
    ],
    { cwd: backendDir, encoding: "utf8", maxBuffer: 1 << 24 },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("{"))) as Page;
}

let total = 0;
for (const table of TABLES) {
  let cursor: string | null = null;
  let scanned = 0;
  const found: Page["loose"] = [];
  for (;;) {
    const result: Page = page(table, cursor);
    scanned += result.scanned;
    found.push(...result.loose);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  total += found.length;
  console.log(
    `${table}: ${scanned} rows scanned, ${found.length} with legacy sources`,
  );
  for (const row of found)
    console.log(
      `  note ${row.noteId}${row.revision === null ? "" : ` revision ${row.revision}`}: ${row.sources}`,
    );
}
console.log(
  total
    ? `${total} rows have legacy attachment sources; they stay readable and grant nothing.`
    : "No legacy attachment sources found.",
);
