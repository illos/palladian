import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Principal } from "./access";
import { deltosToDoc, type Warnings } from "./deltos";
import { createNoteRecord, normalizeNewDoc } from "./documents";
import { normalizeEmail } from "./invitations";
import { cleanName, createNotebook } from "./notebooks";

/**
 * The one-off Deltos import (Q15), operator-only: staged rows become notes
 * through the ordinary creation path (validation, block IDs, summaries,
 * library feed), owned and created by the importing person. Every note's
 * client key is `deltos:<id>`, so re-staging or re-running never duplicates.
 * Reports carry counts, kinds and Deltos IDs only, never content.
 */

const warnings = v.record(v.string(), v.number());
const failure = v.object({ deltosId: v.string(), reason: v.string() });

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
  return "The note could not be converted.";
}

/**
 * Convert and fully validate one staged note, as creation would, including
 * its notebook name (null: the person's default notebook).
 */
function convert(row: Doc<"deltosImports">) {
  const notebook = row.notebook === null ? null : cleanName(row.notebook);
  const { doc, warnings } = deltosToDoc(row);
  return {
    notebook,
    doc: normalizeNewDoc(JSON.stringify(doc.toJSON())),
    warnings,
  };
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

/** Without writing anything: what would import, what would fail, what changes. */
export const checkDeltos = internalQuery({
  args: {},
  returns: v.object({
    staged: v.number(),
    convertible: v.number(),
    fileNotes: v.number(),
    notebooks: v.number(),
    unfiled: v.number(),
    failed: v.array(failure),
    warnings,
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("deltosImports")
      .withIndex("by_failure", (q) => q.eq("failure", undefined))
      .take(1000);
    const report = {
      staged: rows.length,
      convertible: 0,
      fileNotes: 0,
      notebooks: 0,
      unfiled: 0,
      failed: [] as { deltosId: string; reason: string }[],
      warnings: {} as Warnings,
    };
    const notebooks = new Set<string>();
    for (const row of rows) {
      try {
        const converted = convert(row);
        merge(report.warnings, converted.warnings);
        if (converted.notebook === null) report.unfiled++;
        else notebooks.add(converted.notebook);
        if (row.fileNote) report.fileNotes++;
        report.convertible++;
      } catch (error) {
        report.failed.push({ deltosId: row.deltosId, reason: reasonOf(error) });
      }
    }
    report.notebooks = notebooks.size;
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

/** Import up to `limit` staged notes for the person with this email. */
export const importDeltos = internalMutation({
  args: { ownerEmail: v.string(), limit: v.number() },
  returns: v.object({
    imported: v.number(),
    alreadyImported: v.number(),
    failed: v.array(failure),
    remaining: v.number(),
    warnings,
  }),
  handler: async (ctx, args) => {
    const person = await owner(ctx, args.ownerEmail);
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit) || 1));
    const rows = await ctx.db
      .query("deltosImports")
      .withIndex("by_failure", (q) => q.eq("failure", undefined))
      .take(limit);
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
      remaining: 0,
      warnings: {} as Warnings,
    };
    for (const row of rows) {
      const clientKey = `deltos:${row.deltosId}`;
      const existing = await ctx.db
        .query("notes")
        .withIndex("by_creator_and_client_key", (q) =>
          q.eq("creatorId", person._id).eq("clientKey", clientKey),
        )
        .unique();
      if (existing) {
        report.alreadyImported++;
        await ctx.db.delete(row._id);
        continue;
      }
      let converted: ReturnType<typeof convert>;
      try {
        converted = convert(row);
      } catch (error) {
        const reason = reasonOf(error);
        report.failed.push({ deltosId: row.deltosId, reason });
        await ctx.db.patch(row._id, { failure: reason });
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
      merge(report.warnings, converted.warnings);
      report.imported++;
      await ctx.db.delete(row._id);
    }
    report.remaining = (
      await ctx.db
        .query("deltosImports")
        .withIndex("by_failure", (q) => q.eq("failure", undefined))
        .take(1000)
    ).length;
    return report;
  },
});

/** Remove staged rows, including failed ones (after an import or to start over). */
export const clearDeltos = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("deltosImports").take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
