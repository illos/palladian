import { ConvexError, v } from "convex/values";
import { query, internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { resourceTarget, filePolicy } from "./fileValues";
import { requireWorkspace, requireInstance } from "./scope";
import { storedResource, type StoredTarget, requireFixtures, resourceSummary } from "./resources";
import { fail } from "./errors";
export async function projectResource(ctx: MutationCtx, target: StoredTarget, revision: number) {
  const { resource } = await storedResource(ctx, target);
  if (resource.revision !== revision) return false;
  const previous = await ctx.db.query("searchEntries").withIndex("by_resource", q => q.eq("target.resourceId", target.resourceId)).unique();
  if (previous && previous.sourceRevision > revision) return false;
  const value = { workspaceId: resource.workspaceId, instanceId: resource.instanceId, target, title: resource.title, text: `${resource.title}\n${resource.text}`.slice(0, filePolicy.projectionCharacters), sourceRevision: revision, projectedAt: Date.now() };
  if (previous) await ctx.db.replace(previous._id, value); else await ctx.db.insert("searchEntries", value);
  return true;
}
export const project = internalMutation({ args: { target: resourceTarget, revision: v.number() }, returns: v.boolean(), handler: (ctx, args) => projectResource(ctx, args.target, args.revision) });
export const search = query({
  args: { workspaceId: v.id("workspaces"), instanceId: v.optional(v.id("appInstances")), text: v.string(), cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  returns: v.object({ items: v.array(v.object({ target: resourceTarget, title: v.string(), snippet: v.string(), sourceRevision: v.number(), instanceTitle: v.string(), href: v.string(), source: v.literal("fixture") })), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId); requireFixtures();
    if (args.instanceId) await requireInstance(ctx, { workspaceId: args.workspaceId, instanceId: args.instanceId });
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || args.text.length < 1 || args.text.length > 256 || args.text.trim().split(/\s+/).length > 16 || (args.cursor !== null && (args.cursor.length < 1 || args.cursor.length > 4096))) fail("VALIDATION");
    const page = await ctx.db.query("searchEntries").withSearchIndex("search_text", q => {
      const scoped = q.search("text", args.text).eq("workspaceId", args.workspaceId);
      return args.instanceId ? scoped.eq("instanceId", args.instanceId) : scoped;
    }).paginate({ numItems: limit, cursor: args.cursor, maximumRowsRead: 100, maximumBytesRead: 2 * 1024 * 1024 });
    const items = [];
    for (const entry of page.page) {
      try {
        const value = await storedResource(ctx, entry.target);
        if (value.resource.workspaceId !== args.workspaceId || value.resource.revision !== entry.sourceRevision) continue;
        const summary = resourceSummary(entry.target, value);
        items.push({ target: entry.target, title: summary.title, snippet: value.resource.text.slice(0, 240), sourceRevision: entry.sourceRevision, instanceTitle: summary.instanceTitle, href: summary.href, source: "fixture" as const });
      } catch (error) {
        if (!(error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === "NOT_FOUND")) throw error;
      }
    }
    return { items, cursor: page.isDone ? null : page.continueCursor };
  },
});
