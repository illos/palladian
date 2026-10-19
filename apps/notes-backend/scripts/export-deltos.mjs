#!/usr/bin/env node
/**
 * Export one Deltos account's live notes for the one-off import (Q15).
 *
 * Reads the Deltos D1 database (read-only queries) and writes JSONL rows for
 * the `deltosImports` staging table to a private file outside the repository.
 * Skips deleted and trashed notes. Prints counts only, never note content.
 *
 *   CLOUDFLARE_ACCOUNT_ID=<id> presidium-env --set cloudflare-blackgate -- \
 *     node apps/notes-backend/scripts/export-deltos.mjs --username jray [--out DIR]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wrangler = resolve(here, "../../notes-edge/node_modules/.bin/wrangler");
const DATABASE = "deltos";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME = /^[a-z0-9_.-]{1,64}$/;
const BATCH = 25;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${name} needs a value`);
  return value;
}

const username = option("username", "").trim().toLowerCase();
if (!USERNAME.test(username)) throw new Error("--username is required");
const out = resolve(
  option("out", join(homedir(), ".local/share/palladian-deltos-import")),
);

/** One read-only statement; values in it have already passed `ID`. */
function query(sql) {
  const stdout = execFileSync(
    wrangler,
    ["d1", "execute", DATABASE, "--remote", "--json", "--command", sql],
    {
      cwd: resolve(here, "../../notes-edge"),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [result] = JSON.parse(stdout);
  if (!result?.success) throw new Error("A Deltos query failed.");
  return result.results;
}

function quoted(id) {
  if (!ID.test(id)) throw new Error("Unexpected Deltos ID format.");
  return `'${id}'`;
}

function time(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Unexpected Deltos date.");
  return ms;
}

function parsed(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** A file note's extracted text: its pages, in order, at blank lines. */
function extractText(properties) {
  const raw = properties["sys:extract"]?.value;
  if (typeof raw !== "string") return null;
  const extract = parsed(raw, null);
  const pages = Array.isArray(extract?.pages) ? extract.pages : [];
  const text = pages
    .map((page) => (typeof page?.t === "string" ? page.t.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  return text || null;
}

const [account] = query(
  `SELECT accountId FROM usernames WHERE usernameNormalized = '${username}'`,
);
if (!account) throw new Error("No Deltos account has that username.");
const accountId = quoted(account.accountId);

const notebooks = new Map(
  query(
    `SELECT id, name FROM notebooks WHERE accountId = ${accountId} AND deletedAt IS NULL`,
  ).map((row) => [row.id, row.name]),
);
const ids = query(
  `SELECT id FROM notes WHERE accountId = ${accountId} AND deletedAt IS NULL ORDER BY createdAt, id`,
).map((row) => row.id);

const counts = {
  liveNotes: ids.length,
  skippedTrashed: 0,
  exported: 0,
  fileNotes: 0,
  fileNotesWithText: 0,
  unfiled: 0,
  inRemovedNotebook: 0,
  notebooks: 0,
};
const used = new Set();
const lines = [];
for (let start = 0; start < ids.length; start += BATCH) {
  const batch = ids
    .slice(start, start + BATCH)
    .map(quoted)
    .join(", ");
  const rows = query(
    `SELECT id, notebookId, title, properties, body, createdAt, updatedAt FROM notes WHERE id IN (${batch}) AND deletedAt IS NULL`,
  );
  for (const row of rows) {
    const properties = parsed(row.properties, {}) ?? {};
    // Deltos's own rule (spine/reservedKeys.ts isTrashed): only a date-typed marker trashes.
    if (properties["sys:trashedAt"]?.type === "date") {
      counts.skippedTrashed++;
      continue;
    }
    const fileNote = properties.fileType?.value === "file";
    const fileExtract = fileNote ? extractText(properties) : null;
    let notebook = null;
    if (row.notebookId && notebooks.has(row.notebookId)) {
      notebook = notebooks.get(row.notebookId);
      used.add(row.notebookId);
    } else if (row.notebookId) counts.inRemovedNotebook++;
    if (notebook === null) counts.unfiled++;
    if (fileNote) counts.fileNotes++;
    if (fileExtract) counts.fileNotesWithText++;
    lines.push(
      JSON.stringify({
        deltosId: row.id,
        notebook,
        title: row.title ?? "",
        body: row.body,
        fileNote,
        fileExtract,
        createdAt: time(row.createdAt),
        updatedAt: time(row.updatedAt),
      }),
    );
    counts.exported++;
  }
}
counts.notebooks = used.size;

mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);
const file = join(out, `deltos-${username}.jsonl`);
writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", {
  mode: 0o600,
});
chmodSync(file, 0o600);
console.log(JSON.stringify({ ...counts, file }, null, 2));
