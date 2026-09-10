import { v } from "convex/values";
import { LIMITS } from "../../packages/contracts/src/index";
import { mutation, query } from "../_generated/server";
import { requireWorkspace, requireInstance } from "./scope";
import { appDefinitions } from "./registry";
import {
  definitionId,
  lifecycle,
  instanceView as validator,
  instanceScopeArgs,
} from "./values";
import { instanceView } from "./views";
import {
  fail,
  nextRevision,
  revision,
  title,
  idempotencyKey,
  pagination,
} from "./errors";
export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    definitionId,
    title: v.string(),
    idempotencyKey: v.string(),
  },
  returns: validator,
  handler: async (ctx, args) => {
    const { identity, workspace } = await requireWorkspace(
      ctx,
      args.workspaceId,
    );
    const normalizedTitle = title(args.title);
    idempotencyKey(args.idempotencyKey);
    const operation = appDefinitions[args.definitionId].operations.create;
    const fingerprint = JSON.stringify({
      definitionId: args.definitionId,
      title: normalizedTitle,
    });
    const receipt = await ctx.db
      .query("operationReceipts")
      .withIndex("by_scope_key", (q) =>
        q
          .eq("ownerId", identity._id)
          .eq("workspaceId", workspace._id)
          .eq("operation", operation)
          .eq("key", args.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail("CONFLICT");
      const prior = await requireInstance(
        ctx,
        { workspaceId: workspace._id, instanceId: receipt.instanceId },
        { includeArchived: true, definitionId: args.definitionId },
      );
      return instanceView(prior.instance);
    }
    const now = Date.now();
    const instanceId = await ctx.db.insert("appInstances", {
      workspaceId: workspace._id,
      definitionId: args.definitionId,
      title: normalizedTitle,
      lifecycle: "active",
      revision: 0,
      preferencesVersion: 0,
      sortOrder: now,
      updatedAt: now,
    });
    await ctx.db.insert("instancePreferences", {
      workspaceId: workspace._id,
      instanceId,
      density: "comfortable",
      revision: 0,
    });
    await ctx.db.insert("operationReceipts", {
      ownerId: identity._id,
      workspaceId: workspace._id,
      operation,
      key: args.idempotencyKey,
      fingerprint,
      instanceId,
    });
    const created = await ctx.db.get(instanceId);
    if (!created) fail("TEMPORARY");
    return instanceView(created);
  },
});
export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    lifecycle,
    cursor: v.union(v.null(), v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(validator),
    cursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    const limit = args.limit ?? LIMITS.listPage;
    pagination(args.cursor, limit);
    const result = await ctx.db
      .query("appInstances")
      .withIndex("by_workspace_lifecycle", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("lifecycle", args.lifecycle),
      )
      .order("asc")
      .paginate({ cursor: args.cursor, numItems: limit });
    return {
      items: result.page.map(instanceView),
      cursor: result.isDone ? null : result.continueCursor,
    };
  },
});
export const get = query({
  args: instanceScopeArgs,
  returns: validator,
  handler: async (ctx, args) =>
    instanceView((await requireInstance(ctx, args)).instance),
});
export const rename = mutation({
  args: {
    ...instanceScopeArgs,
    title: v.string(),
    expectedRevision: v.number(),
  },
  returns: validator,
  handler: async (ctx, args) => {
    const { instance } = await requireInstance(ctx, args);
    const normalizedTitle = title(args.title);
    revision(args.expectedRevision);
    if (instance.revision !== args.expectedRevision) fail("CONFLICT");
    const patch = {
      title: normalizedTitle,
      revision: nextRevision(instance.revision),
      updatedAt: Date.now(),
    };
    await ctx.db.patch(instance._id, patch);
    return instanceView({ ...instance, ...patch });
  },
});
export const archive = mutation({
  args: { ...instanceScopeArgs, expectedRevision: v.number() },
  returns: validator,
  handler: async (ctx, args) => {
    const { instance } = await requireInstance(ctx, args, {
      includeArchived: true,
    });
    revision(args.expectedRevision);
    if (instance.lifecycle === "archived") return instanceView(instance);
    if (instance.revision !== args.expectedRevision) fail("CONFLICT");
    const patch = {
      lifecycle: "archived" as const,
      revision: nextRevision(instance.revision),
      updatedAt: Date.now(),
    };
    await ctx.db.patch(instance._id, patch);
    return instanceView({ ...instance, ...patch });
  },
});
