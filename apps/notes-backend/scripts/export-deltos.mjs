#!/usr/bin/env node
/**
 * Export one Deltos account's live notes for the one-off import (D100–D101).
 *
 * Reads the Deltos D1 database (read-only queries) and writes JSONL rows for
 * the `deltosImports` staging table to a private file outside the repository.
 * Skips deleted and trashed notes. Prints counts only, never note content:
 * every failure is reported with a fixed message, never the underlying error
 * or the database output. DELTOS_WRANGLER overrides the wrangler binary.
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
const wrangler =
  process.env.DELTOS_WRANGLER ??
  resolve(here, "../../notes-edge/node_modules/.bin/wrangler");
const DATABASE = "deltos";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME = /^[a-z0-9_.-]{1,64}$/;
const BATCH = 25;

/** A failure whose message is fixed text, safe to print. */
class Stop extends Error {}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Stop(`--${name} needs a value`);
  return value;
}

/**
 * One read-only statement; values in it have already passed `ID`. The
 * subprocess error and its captured output are never surfaced.
 */
function query(sql) {
  let stdout;
  try {
    stdout = execFileSync(
      wrangler,
      ["d1", "execute", DATABASE, "--remote", "--json", "--command", sql],
      {
        cwd: resolve(here, "../../notes-edge"),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : "unknown";
    throw new Stop(`A Deltos query failed (wrangler exit ${status}).`);
  }
  const result = parsed(stdout, null)?.[0];
  if (!result?.success || !Array.isArray(result.results))
    throw new Stop("A Deltos query returned an unexpected response.");
  return result.results;
}

function quoted(id) {
  if (typeof id !== "string" || !ID.test(id))
    throw new Stop("Unexpected Deltos ID format.");
  return `'${id}'`;
}

function time(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Stop("Unexpected Deltos date.");
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

function main() {
  const username = option("username", "").trim().toLowerCase();
  if (!USERNAME.test(username)) throw new Stop("--username is required");
  const out = resolve(
    option("out", join(homedir(), ".local/share/palladian-deltos-import")),
  );
  const [account] = query(
    `SELECT accountId FROM usernames WHERE usernameNormalized = '${username}'`,
  );
  if (!account) throw new Stop("No Deltos account has that username.");
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
  let fetched = 0;
  const lines = [];
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids
      .slice(start, start + BATCH)
      .map(quoted)
      .join(", ");
    const rows = query(
      `SELECT id, notebookId, title, properties, body, createdAt, updatedAt FROM notes WHERE id IN (${batch}) AND deletedAt IS NULL`,
    );
    fetched += rows.length;
    for (const row of rows) {
      if (typeof row.body !== "string" || typeof row.createdAt !== "string")
        throw new Stop("A Deltos note has an unexpected shape.");
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
  if (fetched !== ids.length)
    throw new Stop("Deltos changed during the export; run it again.");
  counts.notebooks = used.size;

  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const file = join(out, `deltos-${username}.jsonl`);
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  console.log(JSON.stringify({ ...counts, file }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Stop ? error.message : "The export failed.");
  process.exitCode = 1;
}
