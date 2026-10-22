import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  fail,
  hasOwnerAuthority,
  notebookRole,
  requireHuman,
  requirePrincipal,
  type Principal,
} from "./access";
import { membersLosingAccess, moveNote } from "./lifecycle";
import { changeLifecycle } from "./notes";
import { changeRestriction } from "./sharing";

export function cleanName(name: string) {
  const value = name.trim().replace(/\s+/g, " ");
  if (!value || value.length > 100)
    fail("invalid", "Notebook names need 1 to 100 characters.");
  return value;
}
function cleanDescription(description: string) {
  const value = description.trim();
  if (value.length > 1000)
    fail("invalid", "Descriptions are limited to 1000 characters.");
  return value;
}

/** Create a notebook owned by a person; agents create them for their controller. */
export async function createNotebook(
  ctx: MutationCtx,
  actor: Principal | { _id: Id<"principals">; kind: "human" },
  name: string,
  description: string,
) {
  const ownerId =
    actor.kind === "agent" && "controllerId" in actor && actor.controllerId
      ? actor.controllerId
      : actor._id;
  const now = Date.now();
  const notebookId = await ctx.db.insert("notebooks", {
    ownerId,
    name: cleanName(name),
    description: cleanDescription(description),
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("notebookSequences", { notebookId, seq: 0 });
  if (actor._id !== ownerId)
    await ctx.db.insert("notebookMembers", {
      notebookId,
      principalId: actor._id,
      role: "edit",
      grantedBy: ownerId,
      createdAt: now,
    });
  // Agents the owner chose to share every notebook with receive ordinary memberships.
  const agents = await ctx.db
    .query("principals")
    .withIndex("by_controller", (q) => q.eq("controllerId", ownerId))
    .take(100);
  for (const agent of agents) {
    if (!agent.autoShareRole || agent.disabledAt || agent._id === actor._id)
      continue;
    await ctx.db.insert("notebookMembers", {
      notebookId,
      principalId: agent._id,
      role: agent.autoShareRole,
      grantedBy: ownerId,
      createdAt: now,
    });
  }
  return notebookId;
}

export const create = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  returns: v.id("notebooks"),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    return await createNotebook(ctx, actor, args.name, args.description ?? "");
  },
});

export const update = mutation({
  args: {
    notebookId: v.id("notebooks"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook) fail("not_found", "Notebook not found.");
    if (!hasOwnerAuthority(actor, notebook.ownerId, "share"))
      fail("denied", "Only the notebook owner can change it.");
    await ctx.db.patch(notebook._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.description !== undefined
        ? { description: cleanDescription(args.description) }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setDefault = mutation({
  args: { notebookId: v.id("notebooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    if (actor.kind !== "human") fail("denied", "Only people have defaults.");
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || notebook.ownerId !== actor._id)
      fail("not_found", "Notebook not found.");
    await ctx.db.patch(actor._id, { defaultNotebookId: notebook._id });
    return null;
  },
});

/**
 * Deleting a notebook (plan 08, A5). Only its owner, signed in as a person,
 * may delete it, and not while it is their default notebook. Its notes leave
 * first, through the ordinary move and trash paths, for another notebook the
 * owner chooses:
 *
 * - kept there as they are (`trash: false`), like moving each one; or
 * - put in Trash there (`trash: true`). Trash keeps a note's notebook, so the
 *   destination is where a restored note returns.
 *
 * A note that ends up in Trash this way, or was already there, is made
 * private (restricted) when the destination has members, so nobody gains
 * access to it through the deletion. Restricted notes stay restricted and
 * explicit per-note grants are kept, as with any move. A note owned by
 * someone else stops the deletion: the caller has no authority over it.
 *
 * Then the notebook's memberships go, its open invitations are revoked, and
 * its feed entries and the notebook itself are removed. Everyone's sort
 * order and custom positions for it follow in scheduled batches
 * (`arrangement.forgetNotebook`), as moved notes' positions do
 * (`arrangement.forgetStale`); reads leave them out meanwhile.
 *
 * Each call does a bounded amount of work and reports `done: false` until
 * the notebook is gone; the caller repeats it. A notebook that is already
 * gone, or that the caller cannot see, reports `done` without any change, so
 * repeating is harmless and reveals nothing.
 */
const NOTE_BATCH = 50;
const ROW_BATCH = 400;

async function deletionTarget(
  ctx: MutationCtx,
  person: Principal,
  notebook: Doc<"notebooks">,
  destinationId: Id<"notebooks">,
) {
  if (notebook.ownerId !== person._id)
    fail("denied", "Only the notebook's owner can delete it.");
  if (person.defaultNotebookId === notebook._id)
    fail(
      "invalid",
      "This is your default notebook. Choose another default before deleting it.",
    );
  const destination =
    destinationId === notebook._id ? null : await ctx.db.get(destinationId);
  if (!destination || destination.ownerId !== person._id)
    fail("invalid", "Choose another of your notebooks for its notes.");
  return destination;
}

async function hasMembers(
  ctx: QueryCtx | MutationCtx,
  notebookId: Id<"notebooks">,
) {
  const member = await ctx.db
    .query("notebookMembers")
    .withIndex("by_notebook_and_principal", (q) =>
      q.eq("notebookId", notebookId),
    )
    .first();
  return member !== null;
}

/**
 * What deleting a notebook would do, shown before confirming: who would lose
 * what they open through it (as the Move dialog warns), and whether notes put
 * in Trash would be made private in the destination. Null for anyone but the
 * owner, or an invalid destination.
 */
export const deletePreview = query({
  args: {
    notebookId: v.id("notebooks"),
    destinationId: v.id("notebooks"),
    trash: v.boolean(),
  },
  returns: v.union(
    v.null(),
    v.object({
      lost: v.array(
        v.object({ principalId: v.id("principals"), name: v.string() }),
      ),
      destinationShared: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || notebook.ownerId !== person._id) return null;
    const destination =
      args.destinationId === notebook._id
        ? null
        : await ctx.db.get(args.destinationId);
    if (!destination || destination.ownerId !== person._id) return null;
    const destinationShared = await hasMembers(ctx, destination._id);
    // Notes in Trash are private in a shared destination, so its members
    // keep nothing through it either.
    const lost = await membersLosingAccess(
      ctx,
      notebook._id,
      args.trash ? null : destination._id,
    );
    return { lost, destinationShared };
  },
});

export const remove = mutation({
  args: {
    notebookId: v.id("notebooks"),
    /** Another notebook the caller owns, where its notes go. */
    destinationId: v.id("notebooks"),
    /** Put its notes in Trash (filed in the destination) rather than keep them. */
    trash: v.boolean(),
  },
  returns: v.object({ done: v.boolean(), notes: v.number() }),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || !(await notebookRole(ctx, person, notebook)))
      return { done: true, notes: 0 };
    const destination = await deletionTarget(
      ctx,
      person,
      notebook,
      args.destinationId,
    );

    const notes = await ctx.db
      .query("notes")
      .withIndex("by_notebook_and_seq", (q) => q.eq("notebookId", notebook._id))
      .take(NOTE_BATCH);
    if (notes.length) {
      const shared = await hasMembers(ctx, destination._id);
      for (const note of notes) {
        if (note.ownerId !== person._id)
          fail(
            "conflict",
            "This notebook holds a note owned by someone else, so it cannot be deleted.",
          );
        await moveNote(ctx, note, destination._id);
        let moved = (await ctx.db.get(note._id))!;
        if (args.trash || moved.lifecycle === "trashed") {
          if (shared && !moved.restricted) {
            await changeRestriction(ctx, moved, true);
            moved = (await ctx.db.get(note._id))!;
          }
          await changeLifecycle(ctx, moved, true);
        }
      }
      return { done: false, notes: notes.length };
    }

    let budget = ROW_BATCH;
    const members = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", notebook._id),
      )
      .take(budget);
    for (const member of members) await ctx.db.delete(member._id);
    budget -= members.length;
    if (budget > 0) {
      // Open invitations end as Revoke ends them; accepted ones stay as the
      // record of grants already made, which are removed above.
      const now = Date.now();
      const open = await ctx.db
        .query("invitations")
        .withIndex("by_notebook_and_accepted_at_and_revoked_at", (q) =>
          q
            .eq("notebookId", notebook._id)
            .eq("acceptedAt", undefined)
            .eq("revokedAt", undefined),
        )
        .take(budget);
      for (const invitation of open)
        await ctx.db.patch(invitation._id, { revokedAt: now });
      budget -= open.length;
    }
    if (budget > 0) {
      const tombstones = await ctx.db
        .query("noteTombstones")
        .withIndex("by_notebook_and_seq", (q) =>
          q.eq("notebookId", notebook._id),
        )
        .take(budget);
      for (const tombstone of tombstones) await ctx.db.delete(tombstone._id);
      budget -= tombstones.length;
    }
    if (budget <= 0) return { done: false, notes: 0 };
    const sequence = await ctx.db
      .query("notebookSequences")
      .withIndex("by_notebook", (q) => q.eq("notebookId", notebook._id))
      .unique();
    if (sequence) await ctx.db.delete(sequence._id);
    await ctx.db.delete(notebook._id);
    // Everyone's sort order and positions for it go in batches afterwards;
    // reads leave them out once the notebook is gone.
    await ctx.scheduler.runAfter(0, internal.arrangement.forgetNotebook, {
      notebookId: notebook._id,
    });
    return { done: true, notes: 0 };
  },
});
