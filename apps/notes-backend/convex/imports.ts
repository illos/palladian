import { parseStoredDoc, plainText } from "@palladian/notes-core";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Principal } from "./access";
import {
  deltosToDoc,
  DeltosShapeError,
  missingSourceText,
  type Warnings,
} from "./deltos";
import { createNoteRecord, normalizeNewDoc, serializeDoc } from "./documents";
import { normalizeEmail } from "./invitations";
import { cleanName, createNotebook } from "./notebooks";

/**
 * The one-off Deltos import (D100–D101), operator-only: staged rows become
 * notes through the ordinary creation path (validation, block IDs, summaries,
 * library feed), owned and created by the importing person. Every note's
 * client key is `deltos:<id>`, so re-staging or re-running never duplicates.
 * Staged rows stay, linked to their notes, until verification has passed and
 * the operator clears them. Reports carry counts, kinds, fixed reasons and
 * Deltos IDs only, never content. scripts/run-deltos-import.ts drives these
 * functions with success gates between the steps.
 */

const warnings = v.record(v.string(), v.number());
const failure = v.object({ deltosId: v.string(), reason: v.string() });
const page = {
  cursor: v.union(v.string(), v.null()),
  numItems: v.number(),
};
const CLIENT_KEY = "deltos:";
/** Stop a batch once its estimated reads and writes pass this many bytes. */
const BATCH_BYTES = 6_000_000;

function clamp(value: number, max: number) {
  return Math.max(1, Math.min(max, Math.floor(value) || 1));
}

function merge(into: Warnings, from: Warnings) {
  for (const [kind, count] of Object.entries(from))
    into[kind] = (into[kind] ?? 0) + count;
}

/** A reason safe to report: validation messages are generic, others are not. */
function reasonOf(error: unknown) {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "object" && data && "message" in data)
      return String(data.message);
  }
  if (error instanceof SyntaxError) return "The Deltos body is not valid JSON.";
  if (error instanceof DeltosShapeError) return error.message;
  return "The note could not be converted.";
}

/**
 * Convert and fully validate one staged note exactly as creation will,
 * including the size after block IDs are added and its notebook name (null:
 * the person's default notebook).
 */
function convert(row: Doc<"deltosImports">) {
  const notebook = row.notebook === null ? null : cleanName(row.notebook);
  const { doc, warnings } = deltosToDoc(row);
  // Size is checked before and after block IDs are added, as creation does.
  const normalized = normalizeNewDoc(serializeDoc(doc));
  const bytes = serializeDoc(normalized).length;
  return { notebook, doc: normalized, bytes, warnings };
}

/** Rows neither imported nor set aside. */
function pending(ctx: QueryCtx) {
  return ctx.db
    .query("deltosImports")
    .withIndex("by_failure_and_note", (q) =>
      q.eq("failure", undefined).eq("noteId", undefined),
    );
}

/** The importing person, acting directly (not through an agent connection). */
async function owner(ctx: QueryCtx, email: string): Promise<Principal> {
  const person = await ctx.db
    .query("principals")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .unique();
  if (!person || person.kind !== "human" || person.disabledAt !== undefined)
    throw new ConvexError({ code: "not_found", message: "No such person." });
  return { ...person, connectionId: null };
}

/** One page of the dry run over pending rows; writes nothing. */
export const checkDeltos = internalQuery({
  args: page,
  returns: v.object({
    ids: v.array(v.string()),
    convertible: v.number(),
    fileNotes: v.number(),
    unfiled: v.number(),
    failed: v.array(failure),
    warnings,
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await pending(ctx).paginate({
      cursor: args.cursor,
      numItems: clamp(args.numItems, 10),
    });
    const report = {
      ids: [] as string[],
      convertible: 0,
      fileNotes: 0,
      unfiled: 0,
      failed: [] as { deltosId: string; reason: string }[],
      warnings: {} as Warnings,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
    for (const row of result.page) {
      report.ids.push(row.deltosId);
      try {
        const converted = convert(row);
        merge(report.warnings, converted.warnings);
        if (converted.notebook === null) report.unfiled++;
        if (row.fileNote) report.fileNotes++;
        report.convertible++;
      } catch (error) {
        report.failed.push({ deltosId: row.deltosId, reason: reasonOf(error) });
      }
    }
    return report;
  },
});

async function notebookFor(
  ctx: MutationCtx,
  person: Principal,
  /** Already cleaned by `convert`. */
  name: string | null,
  known: Map<string, Doc<"notebooks">>,
) {
  if (name === null) {
    const fallback = person.defaultNotebookId
      ? await ctx.db.get(person.defaultNotebookId)
      : null;
    if (!fallback)
      throw new ConvexError({
        code: "invalid",
        message: "No default notebook.",
      });
    return fallback;
  }
  const existing = known.get(name);
  if (existing) return existing;
  const notebookId = await createNotebook(ctx, person, name, "");
  const created = (await ctx.db.get(notebookId))!;
  known.set(name, created);
  return created;
}

/**
 * Import up to `limit` pending rows for the person with this email, stopping
 * early once the batch's estimated bytes pass BATCH_BYTES. A row that cannot
 * convert is set aside with its reason; any other error aborts the whole
 * batch, leaving nothing half-written.
 */
export const importDeltos = internalMutation({
  args: { ownerEmail: v.string(), limit: v.number() },
  returns: v.object({
    imported: v.number(),
    alreadyImported: v.number(),
    failed: v.array(failure),
    more: v.boolean(),
    warnings,
  }),
  handler: async (ctx, args) => {
    const person = await owner(ctx, args.ownerEmail);
    const rows = await pending(ctx).take(clamp(args.limit, 25));
    const known = new Map<string, Doc<"notebooks">>();
    for (const notebook of await ctx.db
      .query("notebooks")
      .withIndex("by_owner", (q) => q.eq("ownerId", person._id))
      .take(500))
      if (!known.has(notebook.name)) known.set(notebook.name, notebook);
    const report = {
      imported: 0,
      alreadyImported: 0,
      failed: [] as { deltosId: string; reason: string }[],
      more: false,
      warnings: {} as Warnings,
    };
    let bytes = 0;
    for (const row of rows) {
      if (bytes >= BATCH_BYTES) break;
      const rowBytes = row.body.length + (row.fileExtract?.length ?? 0);
      const clientKey = `${CLIENT_KEY}${row.deltosId}`;
      const existing = await ctx.db
        .query("notes")
        .withIndex("by_creator_and_client_key", (q) =>
          q.eq("creatorId", person._id).eq("clientKey", clientKey),
        )
        .unique();
      if (existing) {
        report.alreadyImported++;
        await ctx.db.patch(row._id, { noteId: existing._id });
        bytes += rowBytes * 2;
        continue;
      }
      let converted: ReturnType<typeof convert>;
      try {
        converted = convert(row);
      } catch (error) {
        const reason = reasonOf(error);
        report.failed.push({ deltosId: row.deltosId, reason });
        await ctx.db.patch(row._id, { failure: reason });
        bytes += rowBytes * 2;
        continue;
      }
      const notebook = await notebookFor(
        ctx,
        person,
        converted.notebook,
        known,
      );
      const noteId = await createNoteRecord(ctx, {
        notebook,
        actor: person,
        doc: converted.doc,
        clientKey,
      });
      // Keep the Deltos dates: lists and search order by them.
      await ctx.db.patch(noteId, {
        createdAt: row.createdAt,
        editedAt: row.updatedAt,
      });
      await ctx.db.patch(row._id, { noteId });
      merge(report.warnings, converted.warnings);
      report.imported++;
      // The staged row read and rewritten; content, checkpoint and search text.
      bytes += rowBytes * 2 + converted.bytes * 3;
    }
    report.more = (await pending(ctx).first()) !== null;
    return report;
  },
});

/**
 * One page of verification over every staged row: each must be imported, as
 * the person's own note under its client key, in the expected notebook, with
 * the Deltos dates, and with every piece of its Deltos source text present in
 * the stored document. Problems are fixed labels; nothing is written.
 */
export const verifyDeltos = internalQuery({
  args: { ownerEmail: v.string(), ...page },
  returns: v.object({
    ids: v.array(v.string()),
    problems: v.array(
      v.object({ deltosId: v.string(), problems: v.array(v.string()) }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const person = await owner(ctx, args.ownerEmail);
    const result = await ctx.db.query("deltosImports").paginate({
      cursor: args.cursor,
      numItems: clamp(args.numItems, 10),
    });
    const report = {
      ids: [] as string[],
      problems: [] as { deltosId: string; problems: string[] }[],
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
    for (const row of result.page) {
      report.ids.push(row.deltosId);
      const problems = await verifyRow(ctx, person, row);
      if (problems.length)
        report.problems.push({ deltosId: row.deltosId, problems });
    }
    return report;
  },
});

async function verifyRow(
  ctx: QueryCtx,
  person: Principal,
  row: Doc<"deltosImports">,
): Promise<string[]> {
  if (row.failure !== undefined) return [`set aside: ${row.failure}`];
  if (row.noteId === undefined) return ["not imported"];
  const note = await ctx.db.get(row.noteId);
  if (!note) return ["note missing"];
  const problems: string[] = [];
  if (note.clientKey !== `${CLIENT_KEY}${row.deltosId}`)
    problems.push("client key differs");
  if (note.creatorId !== person._id || note.ownerId !== person._id)
    problems.push("not the person's own note");
  if (note.lifecycle !== "active") problems.push("not active");
  if (note.createdAt !== row.createdAt || note.editedAt !== row.updatedAt)
    problems.push("dates differ");
  let expected: string | null = null;
  try {
    expected = row.notebook === null ? null : cleanName(row.notebook);
  } catch {
    problems.push("notebook name invalid");
  }
  const notebook = await ctx.db.get(note.notebookId);
  if (
    !notebook ||
    notebook.ownerId !== person._id ||
    (expected === null
      ? note.notebookId !== person.defaultNotebookId
      : notebook.name !== expected)
  )
    problems.push("notebook differs");
  const content = await ctx.db
    .query("noteContent")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .unique();
  if (!content) return [...problems, "content missing"];
  const text = missingSourceText(
    row,
    plainText(parseStoredDoc(content.doc)),
    deltosToDoc(row).titleAdded,
  );
  if (text.missing)
    problems.push(`text missing: ${text.missing} of ${text.total} pieces`);
  return problems;
}

/** One page of the Deltos IDs of the person's imported notes, by client key. */
export const importedDeltos = internalQuery({
  args: { ownerEmail: v.string(), ...page },
  returns: v.object({
    ids: v.array(v.string()),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const person = await owner(ctx, args.ownerEmail);
    const result = await ctx.db
      .query("notes")
      .withIndex("by_creator_and_client_key", (q) =>
        q
          .eq("creatorId", person._id)
          .gte("clientKey", CLIENT_KEY)
          // ";" follows ":", so this range is exactly the "deltos:" keys.
          .lt("clientKey", "deltos;"),
      )
      .paginate({ cursor: args.cursor, numItems: clamp(args.numItems, 200) });
    return {
      ids: result.page.flatMap((note) =>
        note.clientKey ? [note.clientKey.slice(CLIENT_KEY.length)] : [],
      ),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/** Remove up to `limit` staged rows, imported or not; repeat until `more` is false. */
export const clearDeltos = internalMutation({
  args: { limit: v.number() },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("deltosImports")
      .take(clamp(args.limit, 50));
    for (const row of rows) await ctx.db.delete(row._id);
    return {
      deleted: rows.length,
      more: (await ctx.db.query("deltosImports").first()) !== null,
    };
  },
});
