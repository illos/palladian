/**
 * The steps of the one-off Deltos import (D100–D101) with a success gate
 * between each, over the internal functions in convex/imports.ts. Callers
 * supply the backend (the CLI in run-deltos-import.ts, or convex-test in
 * tests) and the exact set of exported Deltos IDs. Outcomes carry counts,
 * Deltos IDs and fixed labels only.
 */

type Failure = { deltosId: string; reason: string };
type Page = { cursor: string | null; numItems: number };
type Owned = Page & { ownerEmail: string };

export interface ImportBackend {
  check(args: Page): Promise<{
    ids: string[];
    convertible: number;
    fileNotes: number;
    unfiled: number;
    failed: Failure[];
    warnings: Record<string, number>;
    continueCursor: string;
    isDone: boolean;
  }>;
  importBatch(args: { ownerEmail: string; limit: number }): Promise<{
    imported: number;
    alreadyImported: number;
    failed: Failure[];
    more: boolean;
    warnings: Record<string, number>;
  }>;
  verify(args: Owned): Promise<{
    ids: string[];
    problems: { deltosId: string; problems: string[] }[];
    continueCursor: string;
    isDone: boolean;
  }>;
  imported(args: Owned): Promise<{
    ids: string[];
    continueCursor: string;
    isDone: boolean;
  }>;
  clear(args: { limit: number }): Promise<{ deleted: number; more: boolean }>;
}

export interface Outcome {
  ok: boolean;
  problems: string[];
  summary: Record<string, unknown>;
}

const SHOWN = 20;

function addAll(into: Record<string, number>, from: Record<string, number>) {
  for (const [kind, count] of Object.entries(from))
    into[kind] = (into[kind] ?? 0) + count;
}

/** Differences between the exported IDs and the IDs found, as problems. */
export function compareIds(
  label: string,
  expected: readonly string[],
  found: readonly string[],
  allowMissing = false,
): string[] {
  const problems: string[] = [];
  const want = new Set(expected);
  const have = new Set(found);
  if (have.size !== found.length)
    problems.push(`${label}: ${found.length - have.size} duplicate IDs`);
  const missing = [...want].filter((id) => !have.has(id));
  const extra = [...have].filter((id) => !want.has(id));
  if (missing.length && !allowMissing)
    problems.push(
      `${label}: ${missing.length} missing (${missing.slice(0, SHOWN).join(", ")})`,
    );
  if (extra.length)
    problems.push(
      `${label}: ${extra.length} unexpected (${extra.slice(0, SHOWN).join(", ")})`,
    );
  return problems;
}

async function pages<T extends { continueCursor: string; isDone: boolean }>(
  load: (cursor: string | null) => Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await load(cursor);
    out.push(page);
    if (page.isDone) return out;
    cursor = page.continueCursor;
  }
}

/**
 * Dry run: every exported note is staged once, pending, and converts. When
 * resuming an import, notes imported by earlier batches are no longer pending.
 */
export async function check(
  backend: ImportBackend,
  expected: readonly string[],
  resuming = false,
): Promise<Outcome> {
  const all = await pages((cursor) => backend.check({ cursor, numItems: 10 }));
  const ids = all.flatMap((page) => page.ids);
  const failed = all.flatMap((page) => page.failed);
  const warnings: Record<string, number> = {};
  for (const page of all) addAll(warnings, page.warnings);
  const problems = compareIds("pending staged notes", expected, ids, resuming);
  if (failed.length)
    problems.push(
      `${failed.length} notes cannot convert: ${failed
        .slice(0, SHOWN)
        .map((f) => `${f.deltosId} (${f.reason})`)
        .join(", ")}`,
    );
  const sum = (key: "convertible" | "fileNotes" | "unfiled") =>
    all.reduce((total, page) => total + page[key], 0);
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      staged: ids.length,
      convertible: sum("convertible"),
      fileNotes: sum("fileNotes"),
      unfiled: sum("unfiled"),
      failed: failed.length,
      warnings,
    },
  };
}

/**
 * Verification: every staged row imported and intact; the note set matches
 * the export. While clearing, rows deleted by an earlier, interrupted clear
 * (verified before it began) may be gone.
 */
export async function verify(
  backend: ImportBackend,
  ownerEmail: string,
  expected: readonly string[],
  clearing = false,
): Promise<Outcome> {
  const checked = await pages((cursor) =>
    backend.verify({ ownerEmail, cursor, numItems: 10 }),
  );
  const keys = await pages((cursor) =>
    backend.imported({ ownerEmail, cursor, numItems: 200 }),
  );
  const ids = checked.flatMap((page) => page.ids);
  const imported = keys.flatMap((page) => page.ids);
  const rows = checked.flatMap((page) => page.problems);
  const problems = [
    ...compareIds("staged notes", expected, ids, clearing),
    ...compareIds("imported notes", expected, imported),
  ];
  if (rows.length)
    problems.push(
      `${rows.length} notes failed verification: ${rows
        .slice(0, SHOWN)
        .map((row) => `${row.deltosId} (${row.problems.join("; ")})`)
        .join(", ")}`,
    );
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      staged: ids.length,
      importedNotes: imported.length,
      failedVerification: rows.length,
    },
  };
}

/**
 * Check, import in batches (stopping at the first failure), then verify.
 * Rerunning after an interruption continues with the rows still pending.
 */
export async function runImport(
  backend: ImportBackend,
  ownerEmail: string,
  expected: readonly string[],
  limit = 10,
): Promise<Outcome> {
  const checked = await check(backend, expected, true);
  if (!checked.ok)
    return {
      ok: false,
      problems: ["check failed; nothing imported", ...checked.problems],
      summary: { check: checked.summary },
    };
  const totals = { batches: 0, imported: 0, alreadyImported: 0 };
  const warnings: Record<string, number> = {};
  for (;;) {
    const batch = await backend.importBatch({ ownerEmail, limit });
    totals.batches++;
    totals.imported += batch.imported;
    totals.alreadyImported += batch.alreadyImported;
    addAll(warnings, batch.warnings);
    const progress =
      batch.imported + batch.alreadyImported + batch.failed.length;
    const problem = batch.failed.length
      ? `stopped: ${batch.failed
          .map((f) => `${f.deltosId} (${f.reason})`)
          .join(", ")}`
      : batch.more && progress === 0
        ? "stopped: a batch made no progress"
        : null;
    if (problem)
      return {
        ok: false,
        problems: [problem],
        summary: { check: checked.summary, ...totals, warnings },
      };
    if (!batch.more) break;
  }
  const verified = await verify(backend, ownerEmail, expected);
  return {
    ok: verified.ok,
    problems: verified.problems,
    summary: {
      check: checked.summary,
      ...totals,
      warnings,
      verify: verified.summary,
    },
  };
}

/**
 * Empty the staging table, only after verification passes, and confirm it is
 * empty. Rerunning after an interruption finishes the job.
 */
export async function clear(
  backend: ImportBackend,
  ownerEmail: string,
  expected: readonly string[],
): Promise<Outcome> {
  const verified = await verify(backend, ownerEmail, expected, true);
  if (!verified.ok)
    return {
      ok: false,
      problems: ["verification failed; staging kept", ...verified.problems],
      summary: { verify: verified.summary },
    };
  let deleted = 0;
  for (;;) {
    const batch = await backend.clear({ limit: 25 });
    deleted += batch.deleted;
    if (!batch.more) break;
    if (!batch.deleted) {
      return {
        ok: false,
        problems: ["clearing made no progress"],
        summary: { deleted },
      };
    }
  }
  const left = await backend.verify({ ownerEmail, cursor: null, numItems: 1 });
  const empty = left.ids.length === 0;
  return {
    ok: empty,
    problems: empty ? [] : ["staging is not empty after clearing"],
    summary: { verify: verified.summary, deleted },
  };
}

/** Whether the staging table holds no rows at all. */
export async function stagingEmpty(backend: ImportBackend, ownerEmail: string) {
  const first = await backend.verify({ ownerEmail, cursor: null, numItems: 1 });
  return first.ids.length === 0;
}
