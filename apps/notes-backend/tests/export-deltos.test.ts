// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const script = resolve(__dirname, "../scripts/export-deltos.mjs");
const MARKER = "SYNTHETIC-PRIVATE-TEXT";

/**
 * A stand-in for `wrangler d1 execute` that answers the export's queries with
 * synthetic rows, or fails in the way FAKE_MODE asks, always with the marker
 * text in its output so a leak would show.
 */
const fake = String.raw`#!/usr/bin/env node
const mode = process.env.FAKE_MODE;
const sql = process.argv[process.argv.indexOf("--command") + 1];
if (mode === "fail") {
  process.stdout.write("${MARKER} on stdout");
  process.stderr.write("${MARKER} on stderr");
  process.exit(3);
}
if (mode === "garbage") {
  process.stdout.write("not json ${MARKER}");
  process.exit(0);
}
const body = (text) =>
  JSON.stringify([{ id: "b", type: "paragraph", content: { segments: [{ text }] }, children: [] }]);
let results = [];
if (sql.includes("FROM usernames")) results = [{ accountId: "acct-1" }];
else if (sql.includes("FROM notebooks")) results = [{ id: "nb-1", name: "Work" }];
else if (sql.startsWith("SELECT id FROM notes"))
  results = ["n1", "n2", "n3", "n4", "n5"].map((id) => ({ id }));
else if (sql.includes("WHERE id IN"))
  results = [
    { id: "n1", notebookId: "nb-1", title: "One", properties: "{}", body: body("${MARKER} one"),
      createdAt: "2024-01-02T03:04:05.000Z", updatedAt: "2025-07-08T09:10:11.000Z" },
    { id: "n2", notebookId: "nb-1", title: "Trashed",
      properties: JSON.stringify({ "sys:trashedAt": { type: "date", value: "2025-01-01T00:00:00Z" } }),
      body: body("${MARKER} two"), createdAt: "2024-01-02T03:04:05Z", updatedAt: "2024-01-02T03:04:05Z" },
    { id: "n3", notebookId: null, title: "Odd marker",
      properties: JSON.stringify({ "sys:trashedAt": { type: "text", value: "x" } }),
      body: body("three"), createdAt: "2024-01-02T03:04:05Z", updatedAt: "2024-01-02T03:04:05Z" },
    { id: "n4", notebookId: "nb-gone", title: "scan.pdf",
      properties: JSON.stringify({
        fileType: { type: "text", value: "file" },
        "sys:extract": { type: "text", value: JSON.stringify({ v: 1, pages: [{ p: 2, t: " second " }, { p: 1, t: "" }, { p: 3, t: "third" }] }) },
      }),
      body: body(""), createdAt: "2024-01-02T03:04:05Z", updatedAt: "2024-01-02T03:04:05Z" },
    { id: "n5", notebookId: null, title: "", properties: "not json", body: "[]",
      createdAt: "2024-01-02T03:04:05Z", updatedAt: "2024-01-02T03:04:05Z" },
  ];
process.stdout.write(JSON.stringify([{ results, success: true }]));
`;

let dir: string;
let wrangler: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deltos-export-test-"));
  wrangler = join(dir, "wrangler");
  writeFileSync(wrangler, fake);
  chmodSync(wrangler, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(mode: string, args = ["--username", "jray"]) {
  const out = join(dir, "out");
  const result = spawnSync(process.execPath, [script, ...args, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, DELTOS_WRANGLER: wrangler, FAKE_MODE: mode },
  });
  return { ...result, out };
}

describe("Deltos export script", () => {
  test("writes live, untrashed notes privately and prints counts only", () => {
    const result = run("ok");
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(MARKER);
    const counts = JSON.parse(result.stdout);
    expect(counts).toMatchObject({
      liveNotes: 5,
      skippedTrashed: 1,
      exported: 4,
      fileNotes: 1,
      fileNotesWithText: 1,
      unfiled: 3,
      inRemovedNotebook: 1,
      notebooks: 1,
    });
    expect(statSync(result.out).mode & 0o777).toBe(0o700);
    const file = join(result.out, "deltos-jray.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((r) => r.deltosId)).toEqual(["n1", "n3", "n4", "n5"]);
    expect(rows[0]).toMatchObject({
      notebook: "Work",
      title: "One",
      fileNote: false,
      fileExtract: null,
      createdAt: Date.UTC(2024, 0, 2, 3, 4, 5),
      updatedAt: Date.UTC(2025, 6, 8, 9, 10, 11),
    });
    // A marker that is not date-typed does not trash, as in Deltos.
    expect(rows[1].title).toBe("Odd marker");
    // Pages keep their stored order; empty pages are dropped.
    expect(rows[2]).toMatchObject({
      notebook: null,
      fileNote: true,
      fileExtract: "second\n\nthird",
    });
  });

  test.each(["fail", "garbage"])(
    "reports a %s query with a fixed message, never its output",
    (mode) => {
      const result = run(mode);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(MARKER);
      expect(result.stderr.trim()).toBe(
        mode === "fail"
          ? "A Deltos query failed (wrangler exit 3)."
          : "A Deltos query returned an unexpected response.",
      );
    },
  );

  test("requires a username", () => {
    const result = run("ok", []);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("--username is required");
  });
});
