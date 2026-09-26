import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { definitionId } from "./values";
import { resourceTarget, filePolicy } from "./fileValues";
import { requireFixtures } from "./resources";
import { projectResource } from "./search";
import { fail, title as validTitle, revision as validRevision } from "./errors";
/** Operator-only test sources. No public content-creation or authorization bypass. */
export const create = internalMutation({
  args: { workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), definitionId, title: v.string(), text: v.string() }, returns: resourceTarget,
  handler: async (ctx, args) => {
    requireFixtures();
    const instance = await ctx.db.get(args.instanceId);
    if (!instance || instance.workspaceId !== args.workspaceId || instance.definitionId !== args.definitionId || instance.lifecycle !== "active") fail("NOT_FOUND");
    if (args.text.length > filePolicy.projectionCharacters) fail("VALIDATION");
    const value = { workspaceId: args.workspaceId, instanceId: args.instanceId, title: validTitle(args.title), text: args.text, revision: 0, trashed: false };
    const target = args.definitionId === "notes" ? { definitionId: "notes" as const, resourceType: "note" as const, instanceId: args.instanceId, resourceId: await ctx.db.insert("noteFixtures", value) } : { definitionId: "recipes" as const, resourceType: "recipe" as const, instanceId: args.instanceId, resourceId: await ctx.db.insert("recipeFixtures", value) };
    await projectResource(ctx, target, 0);
    return target;
  },
});
export const update = internalMutation({
  args: { target: resourceTarget, title: v.string(), text: v.string(), trashed: v.boolean(), expectedRevision: v.number(), deferProjection: v.optional(v.boolean()) }, returns: v.number(),
  handler: async (ctx, args) => {
    requireFixtures(); validRevision(args.expectedRevision);
    const record = await ctx.db.get(args.target.resourceId);
    if (!record || record.instanceId !== args.target.instanceId) fail("NOT_FOUND");
    if (record.revision !== args.expectedRevision) fail("CONFLICT");
    if (args.text.length > filePolicy.projectionCharacters) fail("VALIDATION");
    const revision = record.revision + 1;
    await ctx.db.patch(record._id, { title: validTitle(args.title), text: args.text, trashed: args.trashed, revision });
    if (!args.trashed && !args.deferProjection) await projectResource(ctx, args.target, revision);
    return revision;
  },
});
