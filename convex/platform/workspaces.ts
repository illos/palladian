import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requirePlatformIdentity, requireWorkspace } from "./scope";
import { workspaceView as validator, theme } from "./values";
import { workspaceView } from "./views";
import { fail, nextRevision, revision } from "./errors";
export const ensure = mutation({
  args: {},
  returns: validator,
  handler: async (ctx) => {
    const identity = await requirePlatformIdentity(ctx);
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity._id))
      .unique();
    if (existing) return workspaceView(existing);
    const id = await ctx.db.insert("workspaces", {
      ownerId: identity._id,
      title: "My workspace",
      theme: "system",
      revision: 0,
    });
    const created = await ctx.db.get(id);
    if (!created) fail("TEMPORARY");
    return workspaceView(created);
  },
});
export const current = query({
  args: {},
  returns: v.union(v.null(), validator),
  handler: async (ctx) => {
    const identity = await requirePlatformIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity._id))
      .unique();
    return workspace ? workspaceView(workspace) : null;
  },
});
export const setTheme = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    theme,
    expectedRevision: v.number(),
  },
  returns: validator,
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspace(ctx, args.workspaceId);
    revision(args.expectedRevision);
    if (workspace.revision !== args.expectedRevision) fail("CONFLICT");
    await ctx.db.patch(workspace._id, {
      theme: args.theme,
      revision: nextRevision(workspace.revision),
    });
    return workspaceView({
      ...workspace,
      theme: args.theme,
      revision: nextRevision(workspace.revision),
    });
  },
});
