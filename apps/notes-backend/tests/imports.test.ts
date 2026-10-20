/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import { deltosToDoc } from "../convex/deltos";
import { normalizeNewDoc } from "../convex/documents";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";
import {
  check,
  clear,
  runImport,
  verify,
  type ImportBackend,
} from "../scripts/deltos-runner";

const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
type T = ReturnType<typeof setup>;

const EMAIL = "owner@example.com";

/** A person with a default notebook and a live session. */
async function person(t: T, email = EMAIL) {
  const now = Date.now();
  const made = await t.run(async (ctx) => {
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Owner",
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };
    const session = (await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            userId: user._id,
            token: crypto.randomUUID(),
            expiresAt: now + 86_400_000,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    )) as { _id: string };
    const id = await ctx.db.insert("principals", {
      kind: "human",
      name: "Owner",
      email,
      authUserId: user._id,
      createdAt: now,
    });
    const notebookId = await ctx.db.insert("notebooks", {
      ownerId: id,
      name: "Notes",
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("notebookSequences", { notebookId, seq: 0 });
    await ctx.db.patch(id, { defaultNotebookId: notebookId });
    return { id, notebookId, userId: user._id, sessionId: session._id };
  });
  return {
    ...made,
    as: t.withIdentity({
      subject: made.userId,
      sessionId: made.sessionId,
      issuer: "https://site.test",
    }),
  };
}

const CREATED = Date.UTC(2024, 0, 2, 3, 4, 5);
const UPDATED = Date.UTC(2025, 6, 8, 9, 10, 11);

function paragraphs(id: string, texts: string[]) {
  return texts.map((text, index) => ({
    id: `${id}-p${index}`,
    type: "paragraph",
    content: { segments: [{ text }] },
    children: [],
  }));
}

function row(
  deltosId: string,
  notebook: string | null,
  title: string,
  body: unknown = paragraphs(deltosId, [`Body of ${title}`]),
) {
  return {
    deltosId,
    notebook,
    title,
    body: typeof body === "string" ? body : JSON.stringify(body),
    fileNote: false,
    fileExtract: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
}
type Row = ReturnType<typeof row>;

async function stage(t: T, rows: Row[]) {
  await t.run(async (ctx) => {
    for (const value of rows) await ctx.db.insert("deltosImports", value);
  });
}

async function counts(t: T) {
  return await t.run(async (ctx) => {
    const staged = await ctx.db.query("deltosImports").collect();
    return {
      staged: staged.length,
      pending: staged.filter((r) => !r.noteId && !r.failure).length,
      notes: (await ctx.db.query("notes").collect()).length,
      notebooks: (await ctx.db.query("notebooks").collect()).length,
    };
  });
}

async function checkAll(t: T) {
  const ids: string[] = [];
  const failed: { deltosId: string; reason: string }[] = [];
  let convertible = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: FunctionReturnType<typeof internal.imports.checkDeltos> =
      await t.query(internal.imports.checkDeltos, { cursor, numItems: 2 });
    ids.push(...page.ids);
    failed.push(...page.failed);
    convertible += page.convertible;
    if (page.isDone) return { ids, failed, convertible };
    cursor = page.continueCursor;
  }
}

function importBatch(t: T, limit = 25) {
  return t.mutation(internal.imports.importDeltos, {
    ownerEmail: EMAIL,
    limit,
  });
}

function backend(t: T): ImportBackend {
  return {
    check: (args) => t.query(internal.imports.checkDeltos, args),
    importBatch: (args) => t.mutation(internal.imports.importDeltos, args),
    verify: (args) => t.query(internal.imports.verifyDeltos, args),
    imported: (args) => t.query(internal.imports.importedDeltos, args),
    clear: (args) => t.mutation(internal.imports.clearDeltos, args),
  };
}

async function noteByKey(t: T, deltosId: string) {
  return await t.run(async (ctx) => {
    const notes = await ctx.db.query("notes").collect();
    return notes.find((n) => n.clientKey === `deltos:${deltosId}`)!;
  });
}

async function verifyProblems(t: T) {
  const result = await t.query(internal.imports.verifyDeltos, {
    ownerEmail: EMAIL,
    cursor: null,
    numItems: 10,
  });
  return Object.fromEntries(
    result.problems.map((p) => [p.deltosId, p.problems]),
  );
}

/** Many short to-dos: block IDs added at creation make the document noticeably larger. */
function todos(id: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${id}-${String(index).padStart(6, "0")}`,
    type: "todo",
    content: { checked: false, segments: [{ text: "x" }] },
    children: [],
  }));
}

function sizes(body: unknown) {
  const doc = deltosToDoc(row("size", null, "", body)).doc;
  const json = JSON.stringify(doc.toJSON());
  return {
    before: json.length,
    after: JSON.stringify(normalizeNewDoc(json).toJSON()).length,
  };
}

describe("Deltos import functions", () => {
  test("the check reports without writing anything", async () => {
    const t = setup();
    await person(t);
    await stage(t, [
      row("a", "Work", "A"),
      row("b", "Work", "B"),
      row("c", null, "C"),
      row("d", "Home", "D", "{"),
      row("e", " ", "E"),
      row("f", null, "F", "{}"),
    ]);
    const before = await counts(t);
    const report = await checkAll(t);
    expect(report.ids.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(report.convertible).toBe(3);
    expect(report.failed).toHaveLength(3);
    expect(report.failed).toEqual(
      expect.arrayContaining([
        { deltosId: "d", reason: "The Deltos body is not valid JSON." },
        { deltosId: "e", reason: "Notebook names need 1 to 100 characters." },
        {
          deltosId: "f",
          reason: "The Deltos body is not a valid block list.",
        },
      ]),
    );
    expect(await counts(t)).toEqual(before);
  });

  test("imports into named, reused and default notebooks with the Deltos dates", async () => {
    const t = setup();
    const owner = await person(t);
    // An existing notebook with the same name is reused, not duplicated.
    const work = await t.run(async (ctx) => {
      const id = await ctx.db.insert("notebooks", {
        ownerId: owner.id,
        name: "Work",
        description: "",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("notebookSequences", { notebookId: id, seq: 0 });
      return id;
    });
    await stage(t, [
      row("a", "Work", "Alpha"),
      row("b", "  Home  ", "Beta"),
      row("c", null, "Gamma"),
      row("d", "Home", "Delta"),
      row("e", null, "", [
        {
          id: "e-a",
          type: "attachment",
          content: { name: "Scan.pdf" },
          children: [],
        },
      ]),
    ]);

    const reports = [];
    for (let round = 0; round < 5; round++) {
      const report = await importBatch(t, 2);
      reports.push(report);
      if (!report.more) break;
    }
    expect(reports.map((r) => [r.imported, r.more])).toEqual([
      [2, true],
      [2, true],
      [1, false],
    ]);
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(reports.at(-1)?.warnings).toEqual({
      "attachment to bring over with files": 1,
    });

    const notebooks = await owner.as.query(api.library.notebooks, {});
    expect(notebooks.map((n) => n.name).sort()).toEqual([
      "Home",
      "Notes",
      "Work",
    ]);
    const home = notebooks.find((n) => n.name === "Home")!;

    const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
    expect(notes).toHaveLength(5);
    const byKey = new Map(notes.map((n) => [n.clientKey, n]));
    expect(byKey.get("deltos:a")?.notebookId).toBe(work);
    expect(byKey.get("deltos:b")?.notebookId).toBe(home.id);
    expect(byKey.get("deltos:d")?.notebookId).toBe(home.id);
    expect(byKey.get("deltos:c")?.notebookId).toBe(owner.notebookId);
    expect(byKey.get("deltos:a")?.title).toBe("Alpha");
    expect(byKey.get("deltos:e")?.title).toBe("📎 Scan.pdf (file to be added)");
    for (const note of notes)
      expect(note).toMatchObject({
        ownerId: owner.id,
        creatorId: owner.id,
        createdAt: CREATED,
        editedAt: UPDATED,
        lifecycle: "active",
      });

    // The ordinary read paths see the imported notes and their text.
    const recent = await owner.as.query(api.library.recent, { limit: 10 });
    expect(recent.notes).toHaveLength(5);
    const found = await owner.as.query(api.library.search, { query: "Beta" });
    expect(found.map((f) => f.summary.title)).toEqual(["Beta"]);
    const markdown = await owner.as.query(api.notes.readMarkdown, {
      noteId: byKey.get("deltos:a")!._id,
      format: "markdown",
    });
    expect(markdown.markdown).toContain("Body of Alpha");
    // Staged rows stay, linked to their notes, until cleared.
    expect(await counts(t)).toMatchObject({ staged: 5, pending: 0 });
    expect(await verifyProblems(t)).toEqual({});
  });

  test("devices following a notebook's feed receive the imported notes", async () => {
    const t = setup();
    const owner = await person(t);
    const before = await owner.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: 0,
    });
    if (!before.access) throw new Error("expected access");
    await stage(t, [row("a", null, "A"), row("b", null, "B")]);
    await importBatch(t);
    const after = await owner.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: before.cursor,
    });
    if (!after.access) throw new Error("expected access");
    expect(after.notes.map((n) => n.title).sort()).toEqual(["A", "B"]);
  });

  test("re-staging and re-running never duplicates a note", async () => {
    const t = setup();
    await person(t);
    const rows = [row("a", "Work", "A"), row("b", null, "B")];
    await stage(t, rows);
    await importBatch(t);
    const first = await counts(t);
    await stage(t, rows);
    const again = await importBatch(t);
    expect(again).toMatchObject({
      imported: 0,
      alreadyImported: 2,
      more: false,
    });
    expect(await counts(t)).toMatchObject({
      notes: first.notes,
      notebooks: first.notebooks,
      pending: 0,
    });
  });

  test("the same note staged twice in one batch becomes one note", async () => {
    const t = setup();
    await person(t);
    await stage(t, [row("a", null, "A"), row("a", null, "A")]);
    const report = await importBatch(t);
    expect(report).toMatchObject({ imported: 1, alreadyImported: 1 });
    expect(await counts(t)).toMatchObject({ notes: 1, pending: 0 });
  });

  test("a note that cannot convert is set aside while the rest import", async () => {
    const t = setup();
    await person(t);
    await stage(t, [
      row("a", null, "A"),
      row("bad", null, "X", "not json"),
      row("shape", null, "Y", '[{"id":"s","type":""}]'),
    ]);
    const report = await importBatch(t);
    expect(report).toMatchObject({ imported: 1, more: false });
    expect(report.failed).toEqual([
      { deltosId: "bad", reason: "The Deltos body is not valid JSON." },
      {
        deltosId: "shape",
        reason: "The Deltos body is not a valid block list.",
      },
    ]);
    // Set-aside rows stay staged for inspection but leave later checks.
    expect(await counts(t)).toMatchObject({ staged: 3, pending: 0, notes: 1 });
    expect((await checkAll(t)).ids).toEqual([]);
    expect((await verifyProblems(t)).bad).toEqual([
      "set aside: The Deltos body is not valid JSON.",
    ]);
  });

  test("the size check counts block IDs added at creation", async () => {
    const t = setup();
    await person(t);
    // A to-do count whose document fits before block IDs are added, not after.
    const perItem = sizes(todos("b", 1000)).before / 1000;
    const count = Math.floor(699_000 / perItem);
    const measured = sizes(todos("b", count));
    expect(measured.before).toBeLessThanOrEqual(700_000);
    expect(measured.after).toBeGreaterThan(700_000);

    await stage(t, [
      row("big", null, "", todos("b", count)),
      row("a", null, "A"),
    ]);
    const tooLarge = "The note would exceed the supported size.";
    expect((await checkAll(t)).failed).toEqual([
      { deltosId: "big", reason: tooLarge },
    ]);
    const report = await importBatch(t);
    expect(report).toMatchObject({
      imported: 1,
      failed: [{ deltosId: "big", reason: tooLarge }],
    });
  });

  test("a failure while writing aborts the whole batch", async () => {
    const t = setup();
    const owner = await person(t);
    await t.run(async (ctx) =>
      ctx.db.patch(owner.id, { defaultNotebookId: undefined }),
    );
    await stage(t, [row("a", "Work", "A"), row("b", null, "B")]);
    const before = await counts(t);
    await expect(importBatch(t)).rejects.toThrow(/No default notebook/);
    // Nothing from the batch persists: no note, no notebook, rows still pending.
    expect(await counts(t)).toEqual(before);
    expect(before).toMatchObject({ notes: 0, pending: 2 });
  });

  test("a batch stops early once it has handled enough bytes", async () => {
    const t = setup();
    await person(t);
    // About 600 KB of document each; three pass the batch byte budget.
    const big = (id: string) =>
      row(id, null, id, paragraphs(id, Array(550).fill("y".repeat(1000))));
    await stage(t, [big("a"), big("b"), big("c"), big("d")]);
    const first = await importBatch(t, 25);
    expect(first.imported).toBeGreaterThan(0);
    expect(first.imported).toBeLessThan(4);
    expect(first.more).toBe(true);
    let more = first.more;
    while (more) more = (await importBatch(t, 25)).more;
    expect(await counts(t)).toMatchObject({ notes: 4, pending: 0 });
  });

  test("requires an existing, enabled person", async () => {
    const t = setup();
    const owner = await person(t);
    await stage(t, [row("a", null, "A")]);
    await expect(
      t.mutation(internal.imports.importDeltos, {
        ownerEmail: "nobody@example.com",
        limit: 5,
      }),
    ).rejects.toThrow();
    await t.run(async (ctx) => ctx.db.patch(owner.id, { disabledAt: 1 }));
    await expect(importBatch(t, 5)).rejects.toThrow();
    // The email is matched as normalized.
    await t.run(async (ctx) =>
      ctx.db.patch(owner.id, { disabledAt: undefined }),
    );
    const report = await t.mutation(internal.imports.importDeltos, {
      ownerEmail: "  Owner@Example.com ",
      limit: 5,
    });
    expect(report.imported).toBe(1);
  });

  test("verification compares each note with its Deltos source", async () => {
    const t = setup();
    const owner = await person(t);
    await stage(t, [
      row("ok", null, "Kept"),
      row("text", null, "Text", paragraphs("text", ["one", "two"])),
      row("dates", null, "Dates"),
      row("moved", "Work", "Moved"),
    ]);
    await importBatch(t);
    expect(await verifyProblems(t)).toEqual({});

    const elsewhere = await t.run(async (ctx) => {
      const id = await ctx.db.insert("notebooks", {
        ownerId: owner.id,
        name: "Elsewhere",
        description: "",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("notebookSequences", { notebookId: id, seq: 0 });
      return id;
    });
    const textNote = await noteByKey(t, "text");
    const datesNote = await noteByKey(t, "dates");
    const movedNote = await noteByKey(t, "moved");
    await t.run(async (ctx) => {
      const content = await ctx.db
        .query("noteContent")
        .withIndex("by_note", (q) => q.eq("noteId", textNote._id))
        .unique();
      const doc = JSON.parse(content!.doc);
      doc.content = doc.content.slice(0, -1); // drop the paragraph "two"
      await ctx.db.patch(content!._id, { doc: JSON.stringify(doc) });
      await ctx.db.patch(datesNote._id, { editedAt: UPDATED + 1 });
      await ctx.db.patch(movedNote._id, { notebookId: elsewhere });
    });
    expect(await verifyProblems(t)).toEqual({
      text: ["text missing: 1 of 3 pieces"],
      dates: ["dates differ"],
      moved: ["notebook differs"],
    });
  });

  test("verification counts repeated text and checks its order", async () => {
    const t = setup();
    await person(t);
    await stage(t, [
      row("twice", null, "Twice", paragraphs("twice", ["same", "same"])),
      row("order", null, "Order", paragraphs("order", ["first", "second"])),
    ]);
    await importBatch(t);
    expect(await verifyProblems(t)).toEqual({});
    const edit = async (
      deltosId: string,
      change: (content: unknown[]) => unknown[],
    ) => {
      const note = await noteByKey(t, deltosId);
      await t.run(async (ctx) => {
        const content = await ctx.db
          .query("noteContent")
          .withIndex("by_note", (q) => q.eq("noteId", note._id))
          .unique();
        const doc = JSON.parse(content!.doc);
        doc.content = change(doc.content);
        await ctx.db.patch(content!._id, { doc: JSON.stringify(doc) });
      });
    };
    // Drop one of two identical paragraphs; swap the other note's paragraphs.
    await edit("twice", (blocks) => blocks.slice(0, -1));
    await edit("order", ([title, a, b]) => [title, b, a]);
    expect(await verifyProblems(t)).toEqual({
      twice: ["text missing: 1 of 3 pieces"],
      order: ["text missing: 1 of 3 pieces"],
    });
  });

  test("clearing removes staged rows in batches", async () => {
    const t = setup();
    await person(t);
    await stage(t, [
      row("a", null, "A"),
      row("b", null, "B"),
      row("c", null, "C"),
    ]);
    expect(
      await t.mutation(internal.imports.clearDeltos, { limit: 2 }),
    ).toEqual({ deleted: 2, more: true });
    expect(
      await t.mutation(internal.imports.clearDeltos, { limit: 2 }),
    ).toEqual({ deleted: 1, more: false });
    expect(await counts(t)).toMatchObject({ staged: 0 });
  });
});

describe("Deltos import runner", () => {
  test("checks, imports, verifies and clears with gates", async () => {
    const t = setup();
    await person(t);
    const rows = [
      row("a", "Work", "A"),
      row("b", null, "B"),
      row("c", "Work", "C"),
    ];
    await stage(t, rows);
    const ids = rows.map((r) => r.deltosId);
    const imported = await runImport(backend(t), EMAIL, ids, 2);
    expect(imported).toMatchObject({
      ok: true,
      problems: [],
      summary: { imported: 3, batches: 2, verify: { importedNotes: 3 } },
    });
    expect((await verify(backend(t), EMAIL, ids)).ok).toBe(true);
    const cleared = await clear(backend(t), EMAIL, ids);
    expect(cleared).toMatchObject({ ok: true, summary: { deleted: 3 } });
    expect(await counts(t)).toMatchObject({ staged: 0, notes: 3 });
  });

  test("an interrupted import or clear finishes when rerun", async () => {
    const t = setup();
    await person(t);
    const rows = [
      row("a", null, "A"),
      row("b", "Work", "B"),
      row("c", null, "C"),
    ];
    await stage(t, rows);
    const ids = rows.map((r) => r.deltosId);
    // One batch committed before the interruption.
    await importBatch(t, 1);
    const resumed = await runImport(backend(t), EMAIL, ids, 1);
    expect(resumed).toMatchObject({ ok: true, summary: { imported: 2 } });
    // Rerunning a finished import only verifies.
    expect(await runImport(backend(t), EMAIL, ids)).toMatchObject({
      ok: true,
      summary: { imported: 0 },
    });
    await t.mutation(internal.imports.clearDeltos, { limit: 1 });
    const cleared = await clear(backend(t), EMAIL, ids);
    expect(cleared).toMatchObject({ ok: true, summary: { deleted: 2 } });
    expect(await counts(t)).toMatchObject({ staged: 0, notes: 3 });
  });

  test("imports nothing when the check fails", async () => {
    const t = setup();
    await person(t);
    const rows = [row("a", null, "A"), row("bad", null, "B", "{")];
    await stage(t, rows);
    const outcome = await runImport(
      backend(t),
      EMAIL,
      rows.map((r) => r.deltosId),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toBe("check failed; nothing imported");
    expect(outcome.problems[1]).toContain(
      "bad (The Deltos body is not valid JSON.)",
    );
    expect(await counts(t)).toMatchObject({ notes: 0, pending: 2 });
  });

  test("reconciles the staged and imported notes with the exported IDs", async () => {
    const t = setup();
    await person(t);
    await stage(t, [row("a", null, "A"), row("extra", null, "E")]);
    const checked = await check(backend(t), ["a", "missing"]);
    expect(checked.ok).toBe(false);
    expect(checked.problems).toEqual([
      "pending staged notes: 1 missing (missing)",
      "pending staged notes: 1 unexpected (extra)",
    ]);
    // An imported note that was not exported also fails verification.
    await importBatch(t);
    const verified = await verify(backend(t), EMAIL, ["a"]);
    expect(verified.problems).toEqual([
      "staged notes: 1 unexpected (extra)",
      "imported notes: 1 unexpected (extra)",
    ]);
  });

  test("keeps staging when verification fails", async () => {
    const t = setup();
    await person(t);
    await stage(t, [row("a", null, "A")]);
    expect((await runImport(backend(t), EMAIL, ["a"])).ok).toBe(true);
    const note = await noteByKey(t, "a");
    await t.run(async (ctx) => ctx.db.patch(note._id, { createdAt: 1 }));
    const outcome = await clear(backend(t), EMAIL, ["a"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toEqual([
      "verification failed; staging kept",
      "1 notes failed verification: a (dates differ)",
    ]);
    expect(await counts(t)).toMatchObject({ staged: 1 });
  });
});
