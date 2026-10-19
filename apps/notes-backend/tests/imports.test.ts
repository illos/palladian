/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

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

function row(
  deltosId: string,
  notebook: string | null,
  title: string,
  body: unknown = [
    {
      id: `${deltosId}-p`,
      type: "paragraph",
      content: { segments: [{ text: `Body of ${title}` }] },
      children: [],
    },
  ],
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

async function stage(t: T, rows: ReturnType<typeof row>[]) {
  await t.run(async (ctx) => {
    for (const value of rows) await ctx.db.insert("deltosImports", value);
  });
}

async function counts(t: T) {
  return await t.run(async (ctx) => ({
    staged: (await ctx.db.query("deltosImports").collect()).length,
    notes: (await ctx.db.query("notes").collect()).length,
    notebooks: (await ctx.db.query("notebooks").collect()).length,
  }));
}

async function importAll(t: T, limit = 2) {
  const reports = [];
  for (let round = 0; round < 20; round++) {
    const report = await t.mutation(internal.imports.importDeltos, {
      ownerEmail: EMAIL,
      limit,
    });
    reports.push(report);
    if (report.remaining === 0) break;
  }
  return reports;
}

describe("Deltos import", () => {
  test("the check reports without writing anything", async () => {
    const t = setup();
    await person(t);
    await stage(t, [
      row("a", "Work", "A"),
      row("b", "Work", "B"),
      row("c", null, "C"),
      row("d", "Home", "D", "{"),
      row("e", " ", "E"),
    ]);
    const before = await counts(t);
    const report = await t.query(internal.imports.checkDeltos, {});
    expect(report).toEqual({
      staged: 5,
      convertible: 3,
      fileNotes: 0,
      notebooks: 1,
      unfiled: 1,
      failed: [
        { deltosId: "d", reason: "The Deltos body is not valid JSON." },
        { deltosId: "e", reason: "Notebook names need 1 to 100 characters." },
      ],
      warnings: {},
    });
    expect(await counts(t)).toEqual(before);
  });

  test("imports into named and default notebooks with the Deltos dates", async () => {
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

    const reports = await importAll(t, 2);
    expect(reports.map((r) => [r.imported, r.remaining])).toEqual([
      [2, 3],
      [2, 1],
      [1, 0],
    ]);
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(reports.at(-1)?.warnings).toEqual({
      "attachment to bring over with files": 1,
    });

    const notebooks = await owner.as.query(api.library.notebooks, {});
    const names = notebooks.map((n) => n.name).sort();
    expect(names).toEqual(["Home", "Notes", "Work"]);
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
    for (const note of notes) {
      expect(note).toMatchObject({
        ownerId: owner.id,
        creatorId: owner.id,
        createdAt: CREATED,
        editedAt: UPDATED,
        lifecycle: "active",
      });
    }

    // The ordinary read paths see the imported notes and their text.
    const recent = await owner.as.query(api.library.recent, { limit: 10 });
    expect(recent.notes).toHaveLength(5);
    const found = await owner.as.query(api.library.search, {
      query: "Beta",
    });
    expect(found.map((f) => f.summary.title)).toEqual(["Beta"]);
    const markdown = await owner.as.query(api.notes.readMarkdown, {
      noteId: byKey.get("deltos:a")!._id,
      format: "markdown",
    });
    expect(markdown.markdown).toContain("Body of Alpha");
    expect(await counts(t)).toMatchObject({ staged: 0 });
  });

  test("re-staging and re-running never duplicates a note", async () => {
    const t = setup();
    await person(t);
    const rows = [row("a", "Work", "A"), row("b", null, "B")];
    await stage(t, rows);
    await importAll(t, 25);
    const first = await counts(t);
    await stage(t, rows);
    const [again] = await importAll(t, 25);
    expect(again).toMatchObject({
      imported: 0,
      alreadyImported: 2,
      remaining: 0,
    });
    expect(await counts(t)).toEqual(first);
  });

  test("a note that cannot convert is set aside while the rest import", async () => {
    const t = setup();
    await person(t);
    await stage(t, [row("a", null, "A"), row("bad", null, "X", "not json")]);
    const reports = await importAll(t, 25);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      imported: 1,
      remaining: 0,
      failed: [
        { deltosId: "bad", reason: "The Deltos body is not valid JSON." },
      ],
    });
    // The failed row stays staged (for inspection) but out of later runs.
    expect(await counts(t)).toMatchObject({ staged: 1, notes: 1 });
    const check = await t.query(internal.imports.checkDeltos, {});
    expect(check.staged).toBe(0);
    expect(await t.mutation(internal.imports.clearDeltos, {})).toBe(1);
    expect(await counts(t)).toMatchObject({ staged: 0, notes: 1 });
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
    await expect(
      t.mutation(internal.imports.importDeltos, {
        ownerEmail: EMAIL,
        limit: 5,
      }),
    ).rejects.toThrow();
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
});
