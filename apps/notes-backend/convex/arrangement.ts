import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  fail,
  loadNote,
  loadNotebook,
  noteRole,
  notebookRole,
  requireHuman,
  type Principal,
} from "./access";

/**
 * How a person arranges their lists (D102): pinned notes, each list's sort
 * order, and custom positions within notebooks. All of it is personal: it
 * never changes what other members see, and it grants nothing. Writes need
 * read access to the note or notebook; reads leave out what the person can no
 * longer open, note by note.
 *
 * Each kind has a per-person quota, so a read covers every row. When a quota
 * is reached, rows the person can no longer use are reclaimed first.
 */

const order = v.union(
  v.literal("edited"),
  v.literal("alpha"),
  v.literal("created"),
  v.literal("custom"),
);

type Person = Principal;

/*
 * Quotas keep every function within Convex's transaction limits (4,096
 * `db.get`/`db.query` calls) with headroom. `mine` checks each row: a pin
 * costs up to 3 calls (the note and `noteRole`); an order or position adds
 * at most 2 per distinct notebook (memoized); a position up to 3 more. Worst
 * case: 100 pins (300) + 100 orders (200) + 500 positions (1,500 + 1,000
 * for 500 notebooks) ≈ 3,000.
 */
export const PIN_LIMIT = 100;
export const ORDER_LIMIT = 100;
export const POSITION_LIMIT = 500;
export const BATCH_LIMIT = 100;
/** Cleanup rows per scheduled run. */
const CLEANUP_BATCH = 200;
/**
 * Fractional position keys: base-62 digits as the app generates them. They
 * never end in "0", so another key always fits after them.
 */
const KEY = /^[0-9A-Za-z]{0,63}[1-9A-Za-z]$/;

/**
 * Access checks for one function run. Notebook access is looked up directly
 * (never inferred from a bounded inventory) and remembered per notebook.
 */
function accessFor(ctx: QueryCtx, person: Person) {
  const notebooks = new Map<string, Promise<boolean>>();
  const notebookReadable = (id: Id<"notebooks">) => {
    let known = notebooks.get(id);
    if (!known) {
      known = (async () => {
        const notebook = await ctx.db.get(id);
        return !!notebook && !!(await notebookRole(ctx, person, notebook));
      })();
      notebooks.set(id, known);
    }
    return known;
  };
  /** The note if the person can still open it. */
  const noteReadable = async (noteId: Id<"notes">) => {
    const note = await ctx.db.get(noteId);
    return note && (await noteRole(ctx, person, note)) ? note : null;
  };
  return {
    noteReadable,
    /** "all", or a notebook the person can read. */
    listReadable: async (list: string) => {
      if (list === "all") return true;
      const id = ctx.db.normalizeId("notebooks", list);
      return !!id && (await notebookReadable(id));
    },
    /**
     * A position counts while its note is readable, still in that notebook,
     * and the notebook itself is readable (a note shared on its own does not
     * make its notebook's custom order usable).
     */
    positionLive: async (row: Doc<"notePositions">) => {
      const note = await noteReadable(row.noteId);
      return (
        !!note &&
        note.notebookId === row.notebookId &&
        (await notebookReadable(row.notebookId))
      );
    },
  };
}

function pinsOf(ctx: QueryCtx, person: Person, limit: number) {
  return ctx.db
    .query("pins")
    .withIndex("by_principal_and_note", (q) => q.eq("principalId", person._id))
    .take(limit);
}

function ordersOf(ctx: QueryCtx, person: Person, limit: number) {
  return ctx.db
    .query("listOrders")
    .withIndex("by_principal_and_list", (q) => q.eq("principalId", person._id))
    .take(limit);
}

function positionsOf(ctx: QueryCtx, person: Person, limit: number) {
  return ctx.db
    .query("notePositions")
    .withIndex("by_principal_and_notebook", (q) =>
      q.eq("principalId", person._id),
    )
    .take(limit);
}

export const mine = query({
  args: {},
  returns: v.object({
    pins: v.array(v.object({ noteId: v.id("notes"), pinnedAt: v.number() })),
    orders: v.array(v.object({ list: v.string(), order })),
    positions: v.array(
      v.object({
        notebookId: v.id("notebooks"),
        noteId: v.id("notes"),
        key: v.string(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const person = await requireHuman(ctx);
    const access = accessFor(ctx, person);
    const pins = [];
    for (const pin of await pinsOf(ctx, person, PIN_LIMIT))
      if (await access.noteReadable(pin.noteId))
        pins.push({ noteId: pin.noteId, pinnedAt: pin.pinnedAt });
    const orders = [];
    for (const row of await ordersOf(ctx, person, ORDER_LIMIT))
      if (await access.listReadable(row.list))
        orders.push({ list: row.list, order: row.order });
    const positions = [];
    for (const row of await positionsOf(ctx, person, POSITION_LIMIT))
      if (await access.positionLive(row))
        positions.push({
          notebookId: row.notebookId,
          noteId: row.noteId,
          key: row.key,
        });
    return { pins, orders, positions };
  },
});

export const setPin = mutation({
  args: { noteId: v.id("notes"), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const existing = await ctx.db
      .query("pins")
      .withIndex("by_principal_and_note", (q) =>
        q.eq("principalId", person._id).eq("noteId", args.noteId),
      )
      .unique();
    // Unpinning only removes the person's own row; it needs no access.
    if (!args.pinned) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    await loadNote(ctx, person, args.noteId, "read");
    if (existing) return null;
    let rows = await pinsOf(ctx, person, PIN_LIMIT);
    if (rows.length >= PIN_LIMIT) {
      const access = accessFor(ctx, person);
      for (const row of rows)
        if (!(await access.noteReadable(row.noteId)))
          await ctx.db.delete(row._id);
      rows = await pinsOf(ctx, person, PIN_LIMIT);
    }
    if (rows.length >= PIN_LIMIT)
      fail("invalid", `You can pin up to ${PIN_LIMIT} notes.`);
    await ctx.db.insert("pins", {
      principalId: person._id,
      noteId: args.noteId,
      pinnedAt: Date.now(),
    });
    return null;
  },
});

/** A list's sort order: "all" for All Notes, or a notebook ID. */
export const setOrder = mutation({
  args: { list: v.string(), order },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (args.list === "all") {
      if (args.order === "custom")
        fail("invalid", "Custom order is set per notebook.");
    } else {
      const notebookId = ctx.db.normalizeId("notebooks", args.list);
      if (!notebookId) fail("not_found", "Notebook not found.");
      await loadNotebook(ctx, person, notebookId, "read");
    }
    const existing = await ctx.db
      .query("listOrders")
      .withIndex("by_principal_and_list", (q) =>
        q.eq("principalId", person._id).eq("list", args.list),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { order: args.order });
      return null;
    }
    let rows = await ordersOf(ctx, person, ORDER_LIMIT);
    if (rows.length >= ORDER_LIMIT) {
      const access = accessFor(ctx, person);
      for (const row of rows)
        if (!(await access.listReadable(row.list)))
          await ctx.db.delete(row._id);
      rows = await ordersOf(ctx, person, ORDER_LIMIT);
    }
    if (rows.length >= ORDER_LIMIT)
      fail("invalid", `You can keep a sort order for ${ORDER_LIMIT} lists.`);
    await ctx.db.insert("listOrders", {
      principalId: person._id,
      list: args.list,
      order: args.order,
    });
    return null;
  },
});

/**
 * Custom positions within one notebook: one entry for an ordinary drag, or
 * many when a notebook is arranged by hand for the first time.
 */
export const setPositions = mutation({
  args: {
    notebookId: v.id("notebooks"),
    entries: v.array(v.object({ noteId: v.id("notes"), key: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (args.entries.length > BATCH_LIMIT)
      fail("too_large", `At most ${BATCH_LIMIT} positions at once.`);
    if (new Set(args.entries.map((e) => e.noteId)).size < args.entries.length)
      fail("invalid", "Each note can have one position.");
    await loadNotebook(ctx, person, args.notebookId, "read");
    const writes: {
      entry: { noteId: Id<"notes">; key: string };
      existing: Doc<"notePositions"> | null;
    }[] = [];
    for (const entry of args.entries) {
      if (!KEY.test(entry.key)) fail("invalid", "Invalid position.");
      const { note } = await loadNote(ctx, person, entry.noteId, "read");
      if (note.notebookId !== args.notebookId)
        fail("invalid", "That note is in another notebook.");
      const [existing, ...extra] = await ctx.db
        .query("notePositions")
        .withIndex("by_principal_and_note", (q) =>
          q.eq("principalId", person._id).eq("noteId", entry.noteId),
        )
        .take(3);
      // One row per person and note; repair any duplicates.
      for (const row of extra) await ctx.db.delete(row._id);
      writes.push({ entry, existing: existing ?? null });
    }
    const added = writes.filter((w) => !w.existing).length;
    if (added) {
      let rows = await positionsOf(ctx, person, POSITION_LIMIT + 1);
      if (rows.length + added > POSITION_LIMIT) {
        const updating = new Set<string>(writes.map((w) => w.entry.noteId));
        const access = accessFor(ctx, person);
        for (const row of rows)
          if (!updating.has(row.noteId) && !(await access.positionLive(row)))
            await ctx.db.delete(row._id);
        rows = await positionsOf(ctx, person, POSITION_LIMIT + 1);
      }
      if (rows.length + added > POSITION_LIMIT)
        fail(
          "too_large",
          `Custom order keeps up to ${POSITION_LIMIT} notes in place.`,
        );
    }
    for (const { entry, existing } of writes)
      if (existing)
        await ctx.db.patch(existing._id, {
          notebookId: args.notebookId,
          key: entry.key,
        });
      else
        await ctx.db.insert("notePositions", {
          principalId: person._id,
          notebookId: args.notebookId,
          noteId: entry.noteId,
          key: entry.key,
        });
    return null;
  },
});

/**
 * Remove everyone's rows that no longer apply to a note: all of them once the
 * note is deleted forever, and positions in other notebooks once it moved.
 * Runs in batches after the change; reads already leave these rows out.
 */
export const forgetStale = internalMutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    let full = false;
    const stale = async (
      range: Parameters<typeof positionsForNote>[2],
    ): Promise<void> => {
      const rows = await positionsForNote(ctx, args.noteId, range);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === CLEANUP_BATCH) full = true;
    };
    if (!note) {
      await stale(null);
      const pins = await ctx.db
        .query("pins")
        .withIndex("by_note", (q) => q.eq("noteId", args.noteId))
        .take(CLEANUP_BATCH);
      for (const pin of pins) await ctx.db.delete(pin._id);
      if (pins.length === CLEANUP_BATCH) full = true;
    } else {
      // Positions in the note's current notebook stay.
      await stale({ below: note.notebookId });
      await stale({ above: note.notebookId });
    }
    if (full)
      await ctx.scheduler.runAfter(0, internal.arrangement.forgetStale, args);
    return null;
  },
});

function positionsForNote(
  ctx: MutationCtx,
  noteId: Id<"notes">,
  range: { below: Id<"notebooks"> } | { above: Id<"notebooks"> } | null,
) {
  return ctx.db
    .query("notePositions")
    .withIndex("by_note_and_notebook", (q) => {
      const note = q.eq("noteId", noteId);
      if (!range) return note;
      return "below" in range
        ? note.lt("notebookId", range.below)
        : note.gt("notebookId", range.above);
    })
    .take(CLEANUP_BATCH);
}
