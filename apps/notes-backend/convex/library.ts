import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import {
  accessibleNotebooks,
  notebookInventory,
  fail,
  getPrincipal,
  noteRole,
  notebookRole,
  requirePrincipal,
  type Principal,
  type Role,
} from "./access";
import { accessRole, noteSummary, toSummary } from "./validators";

const FEED_PAGE = 200;

const notebookView = v.object({
  id: v.id("notebooks"),
  name: v.string(),
  description: v.string(),
  role: accessRole,
  ownerId: v.id("principals"),
  ownerName: v.string(),
  isDefault: v.boolean(),
});

async function notebookViews(ctx: QueryCtx, principal: Principal) {
  const { entries, complete } = await notebookInventory(ctx, principal);
  const owners = new Map<Id<"principals">, string>();
  const views = [];
  for (const { notebook, role } of entries) {
    if (!owners.has(notebook.ownerId))
      owners.set(
        notebook.ownerId,
        (await ctx.db.get(notebook.ownerId))?.name ?? "Unknown",
      );
    views.push({
      id: notebook._id,
      name: notebook.name,
      description: notebook.description,
      role,
      ownerId: notebook.ownerId,
      ownerName: owners.get(notebook.ownerId)!,
      isDefault: principal.defaultNotebookId === notebook._id,
    });
  }
  return {
    views: views.sort((a, b) => a.name.localeCompare(b.name)),
    complete,
  };
}

const GRANT_LIMIT = 2000;

/** Notes shared individually, outside notebooks the caller belongs to. */
async function sharedSummaries(ctx: QueryCtx, principal: Principal) {
  const grants = await ctx.db
    .query("noteMembers")
    .withIndex("by_principal", (q) => q.eq("principalId", principal._id))
    .take(GRANT_LIMIT + 1);
  const result = [];
  for (const grant of grants.slice(0, GRANT_LIMIT)) {
    if (grant.role === "none") continue;
    const note = await ctx.db.get(grant.noteId);
    if (!note) continue;
    const notebook = await ctx.db.get(note.notebookId);
    if (notebook && (await notebookRole(ctx, principal, notebook))) continue;
    result.push(toSummary(note, grant.role));
  }
  return { notes: result, complete: grants.length <= GRANT_LIMIT };
}

/** Notebooks the caller can open. Changes only when notebooks or access change. */
export const notebooks = query({
  args: {},
  returns: v.array(notebookView),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return [];
    return (await notebookViews(ctx, principal)).views;
  },
});

/**
 * One consistent authorization snapshot for device caches: visible notebooks
 * and individually shared notes, read in the same transaction so a client
 * never reconciles one against a stale copy of the other.
 */
export const access = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      notebooks: v.array(notebookView),
      shared: v.array(noteSummary),
      // False when either list was truncated: clients must not revoke from it.
      complete: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const notebooks = await notebookViews(ctx, principal);
    const shared = await sharedSummaries(ctx, principal);
    return {
      notebooks: notebooks.views,
      shared: shared.notes,
      complete: notebooks.complete && shared.complete,
    };
  },
});

/**
 * A notebook's library feed after a cursor. Clients cache what they receive and
 * resubscribe from the returned cursor, so typing in one note never resends the
 * whole library. Rows the caller cannot open come back as removals.
 */
export const changes = query({
  args: { notebookId: v.id("notebooks"), after: v.number() },
  returns: v.union(
    v.object({ access: v.literal(false) }),
    v.object({
      access: v.literal(true),
      notes: v.array(noteSummary),
      removed: v.array(v.id("notes")),
      cursor: v.number(),
      more: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.after) || args.after < 0)
      fail("invalid", "Invalid cursor.");
    const principal = await getPrincipal(ctx);
    if (!principal) return { access: false as const };
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || !(await notebookRole(ctx, principal, notebook)))
      return { access: false as const };
    const rows = await ctx.db
      .query("notes")
      .withIndex("by_notebook_and_seq", (q) =>
        q.eq("notebookId", args.notebookId).gt("seq", args.after),
      )
      .take(FEED_PAGE + 1);
    const tombstones = await ctx.db
      .query("noteTombstones")
      .withIndex("by_notebook_and_seq", (q) =>
        q.eq("notebookId", args.notebookId).gt("seq", args.after),
      )
      .take(FEED_PAGE + 1);
    const merged = [
      ...rows.map((note) => ({ seq: note.seq, note })),
      ...tombstones.map((t) => ({ seq: t.seq, removed: t.noteId })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .slice(0, FEED_PAGE);
    const notes = [];
    const removed: Id<"notes">[] = [];
    for (const entry of merged) {
      if ("removed" in entry) {
        // A moved note stays visible with its new notebook rather than disappearing.
        const moved = await ctx.db.get(entry.removed);
        const movedRole =
          moved && moved.notebookId !== args.notebookId
            ? await noteRole(ctx, principal, moved)
            : null;
        if (moved && movedRole) notes.push(toSummary(moved, movedRole));
        else removed.push(entry.removed);
        continue;
      }
      const role = await noteRole(ctx, principal, entry.note);
      if (role) notes.push(toSummary(entry.note, role));
      else removed.push(entry.note._id);
    }
    const cursor = merged.length ? merged[merged.length - 1]!.seq : args.after;
    return {
      access: true as const,
      notes,
      removed,
      cursor,
      more: rows.length + tombstones.length > merged.length,
    };
  },
});

/** Notes shared with the caller individually, outside notebooks they belong to. */
export const shared = query({
  args: {},
  returns: v.array(noteSummary),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return [];
    return (await sharedSummaries(ctx, principal)).notes;
  },
});

async function memberNotebooks(
  ctx: QueryCtx,
  principal: Principal,
  notebookId: Id<"notebooks"> | undefined,
) {
  const entries = (await accessibleNotebooks(ctx, principal)).filter(
    (e) => !notebookId || e.notebook._id === notebookId,
  );
  return entries.map((e) => e.notebook._id).slice(0, 50);
}

/** Notes granted individually in notebooks the caller does not belong to. */
async function grantedOnly(
  ctx: QueryCtx,
  principal: Principal,
  notebookId: Id<"notebooks"> | undefined,
) {
  const grants = await ctx.db
    .query("noteMembers")
    .withIndex("by_principal", (q) => q.eq("principalId", principal._id))
    .take(100);
  const result: { note: Doc<"notes">; role: Role }[] = [];
  for (const grant of grants) {
    if (grant.role === "none") continue;
    const note = await ctx.db.get(grant.noteId);
    if (!note || (notebookId && note.notebookId !== notebookId)) continue;
    const notebook = await ctx.db.get(note.notebookId);
    if (notebook && (await notebookRole(ctx, principal, notebook))) continue;
    result.push({ note, role: grant.role });
  }
  return result;
}

/** Newest first: edit time, then creation time, then ID. */
function newestFirst(a: Doc<"notes">, b: Doc<"notes">) {
  if (a.editedAt !== b.editedAt) return b.editedAt - a.editedAt;
  if (a._creationTime !== b._creationTime)
    return b._creationTime - a._creationTime;
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

type RecentCursor = { editedAt: number; created: number; id: string };

function parseRecentCursor(cursor: string): RecentCursor {
  const [editedAt, created, id, ...rest] = cursor.split(":");
  const numbers = [Number(editedAt), Number(created)];
  if (rest.length || !id || !numbers.every(Number.isFinite))
    fail("invalid", "Invalid cursor.");
  return { editedAt: numbers[0]!, created: numbers[1]!, id };
}

/** Rows strictly after the cursor in newestFirst order. */
function afterCursor(note: Doc<"notes">, cursor: RecentCursor | null) {
  if (!cursor) return true;
  if (note.editedAt !== cursor.editedAt) return note.editedAt < cursor.editedAt;
  if (note._creationTime !== cursor.created)
    return note._creationTime < cursor.created;
  return note._id < cursor.id;
}

// Notes sharing both edit and creation time need concurrent creations in one
// notebook within the same instant; this bounds that group, not the page.
const TIE_LIMIT = 1000;

/** The first `count` notes of one notebook after the cursor, in order. */
async function notebookPage(
  ctx: QueryCtx,
  notebookId: Id<"notebooks">,
  cursor: RecentCursor | null,
  count: number,
) {
  const index = ctx.db.query("notes");
  if (!cursor)
    return await index
      .withIndex("by_notebook_and_edited", (q) =>
        q.eq("notebookId", notebookId),
      )
      .order("desc")
      .take(count);
  const rows = (
    await index
      .withIndex("by_notebook_and_edited", (q) =>
        q
          .eq("notebookId", notebookId)
          .eq("editedAt", cursor.editedAt)
          .eq("_creationTime", cursor.created),
      )
      .take(TIE_LIMIT)
  )
    .filter((note) => afterCursor(note, cursor))
    .sort(newestFirst)
    .slice(0, count);
  if (rows.length < count)
    rows.push(
      ...(await ctx.db
        .query("notes")
        .withIndex("by_notebook_and_edited", (q) =>
          q
            .eq("notebookId", notebookId)
            .eq("editedAt", cursor.editedAt)
            .lt("_creationTime", cursor.created),
        )
        .order("desc")
        .take(count - rows.length)),
    );
  if (rows.length < count)
    rows.push(
      ...(await ctx.db
        .query("notes")
        .withIndex("by_notebook_and_edited", (q) =>
          q.eq("notebookId", notebookId).lt("editedAt", cursor.editedAt),
        )
        .order("desc")
        .take(count - rows.length)),
    );
  return rows;
}

/** Notes by most recent edit across everything the caller can read. */
export const recent = query({
  args: {
    notebookId: v.optional(v.id("notebooks")),
    // Opaque continuation from a previous page's nextCursor.
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    includeTrashed: v.optional(v.boolean()),
  },
  returns: v.object({
    notes: v.array(noteSummary),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
    const cursor = args.cursor ? parseRecentCursor(args.cursor) : null;
    const count = limit + 1;
    const candidates: Doc<"notes">[] = [];
    // A notebook that filled its page may hold more rows just past its last
    // one; nothing beyond the earliest such row is examined on this page.
    let horizon: Doc<"notes"> | null = null;
    for (const id of await memberNotebooks(ctx, principal, args.notebookId)) {
      const rows = await notebookPage(ctx, id, cursor, count);
      candidates.push(...rows);
      const last = rows.at(-1);
      if (
        rows.length === count &&
        last &&
        (!horizon || newestFirst(last, horizon) < 0)
      )
        horizon = last;
    }
    for (const { note } of await grantedOnly(ctx, principal, args.notebookId))
      if (afterCursor(note, cursor)) candidates.push(note);
    candidates.sort(newestFirst);
    const notes = [];
    let examined: Doc<"notes"> | null = null;
    let exhausted = true;
    for (const note of candidates) {
      if (
        notes.length >= limit ||
        (horizon && newestFirst(note, horizon) > 0)
      ) {
        exhausted = false;
        break;
      }
      examined = note;
      if (note.lifecycle === "trashed" && !args.includeTrashed) continue;
      const role = await noteRole(ctx, principal, note);
      if (role) notes.push(toSummary(note, role));
    }
    if (horizon) exhausted = false;
    return {
      notes,
      nextCursor:
        !exhausted && examined
          ? `${examined.editedAt}:${examined._creationTime}:${examined._id}`
          : null,
    };
  },
});

function excerpt(text: string, query: string) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  const snippet = text
    .slice(start, start + 240)
    .replace(/\s+/g, " ")
    .trim();
  return (
    (start > 0 ? "…" : "") + snippet + (start + 240 < text.length ? "…" : "")
  );
}

/** Full-text search, authorized before any match, count or excerpt is returned. */
export const search = query({
  args: {
    query: v.string(),
    notebookId: v.optional(v.id("notebooks")),
    includeTrashed: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({ summary: noteSummary, excerpt: v.string() })),
  handler: async (ctx, args) => {
    const principal = await requirePrincipal(ctx);
    const text = args.query.trim().slice(0, 200);
    if (!text) return [];
    const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 20)));
    const perNotebook: Doc<"noteText">[][] = [];
    const notebookIds = await memberNotebooks(ctx, principal, args.notebookId);
    if (args.notebookId && !notebookIds.length) {
      const notebook = await ctx.db.get(args.notebookId);
      if (!notebook) fail("not_found", "Notebook not found.");
    }
    for (const id of notebookIds) {
      perNotebook.push(
        await ctx.db
          .query("noteText")
          .withSearchIndex("search_text", (q) => {
            const search = q.search("text", text).eq("notebookId", id);
            return args.includeTrashed ? search : search.eq("trashed", false);
          })
          .take(limit),
      );
    }
    // Individually shared notes are few; match them directly.
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    const direct: Doc<"noteText">[] = [];
    for (const { note } of await grantedOnly(ctx, principal, args.notebookId)) {
      if (note.lifecycle === "trashed" && !args.includeTrashed) continue;
      const row = await ctx.db
        .query("noteText")
        .withIndex("by_note", (q) => q.eq("noteId", note._id))
        .unique();
      const lower = row?.text.toLowerCase() ?? "";
      if (row && terms.every((term) => lower.includes(term))) direct.push(row);
    }
    if (direct.length) perNotebook.push(direct);
    // Interleave notebooks' relevance-ordered results.
    const results = [];
    const roles = new Map<Id<"notes">, Role | null>();
    for (let rank = 0; rank < limit && results.length < limit; rank++) {
      for (const list of perNotebook) {
        const hit = list[rank];
        if (!hit || results.length >= limit) continue;
        const note = await ctx.db.get(hit.noteId);
        if (!note) continue;
        if (!roles.has(note._id))
          roles.set(note._id, await noteRole(ctx, principal, note));
        const role = roles.get(note._id);
        if (!role) continue;
        results.push({
          summary: toSummary(note, role),
          excerpt: excerpt(hit.text, text),
        });
      }
    }
    return results;
  },
});
