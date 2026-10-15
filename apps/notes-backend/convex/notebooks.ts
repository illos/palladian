import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import {
  fail,
  hasOwnerAuthority,
  requirePrincipal,
  type Principal,
} from "./access";

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
