import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, getPrincipal, requireHuman } from "./access";

export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("principals"),
      kind: v.union(v.literal("human"), v.literal("agent")),
      name: v.string(),
      email: v.union(v.string(), v.null()),
      defaultNotebookId: v.union(v.id("notebooks"), v.null()),
      trashRetentionDays: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    return {
      id: principal._id,
      kind: principal.kind,
      name: principal.name,
      email: principal.email ?? null,
      defaultNotebookId: principal.defaultNotebookId ?? null,
      trashRetentionDays: principal.trashRetentionDays ?? 30,
    };
  },
});

export const rename = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const name = args.name.trim();
    if (!name || name.length > 100) fail("invalid", "Enter a name.");
    await ctx.db.patch(person._id, { name });
    return null;
  },
});
