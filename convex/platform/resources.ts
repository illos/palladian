import { v, type Infer } from "convex/values";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { resourceTarget, resourceView } from "./fileValues";
import { requireInstance } from "./scope";
import { fail } from "./errors";
import { resourceHref } from "../../packages/contracts/src/routes";
export type StoredTarget = Infer<typeof resourceTarget>;
export function requireFixtures() {
  if (process.env.PALLADIAN_ENABLE_P3_FIXTURES !== "true") fail("NOT_FOUND");
}
/** Fixed typed source registration. P4 adds real app tables separately. */
export async function storedResource(ctx: QueryCtx, target: StoredTarget) {
  requireFixtures();
  const resource = target.definitionId === "notes"
    ? await ctx.db.get(target.resourceId)
    : await ctx.db.get(target.resourceId);
  const instance = await ctx.db.get(target.instanceId);
  if (!resource || !instance || instance.lifecycle !== "active" || instance.definitionId !== target.definitionId || resource.trashed || resource.instanceId !== instance._id || resource.workspaceId !== instance.workspaceId) fail("NOT_FOUND");
  return { resource, instance };
}
export async function authorizedResource(ctx: QueryCtx, workspaceId: Infer<typeof resourceView>["workspaceId"], target: StoredTarget) {
  await requireInstance(ctx, { workspaceId, instanceId: target.instanceId }, { definitionId: target.definitionId });
  const result = await storedResource(ctx, target);
  if (result.resource.workspaceId !== workspaceId) fail("NOT_FOUND");
  return result;
}
export function resourceSummary(target: StoredTarget, value: Awaited<ReturnType<typeof storedResource>>) {
  return { target, workspaceId: value.resource.workspaceId, title: value.resource.title, text: value.resource.text, revision: value.resource.revision, source: "fixture" as const, instanceTitle: value.instance.title, href: resourceHref(value.resource.workspaceId, target, "integrated") };
}
export const resolve = query({ args: { workspaceId: v.id("workspaces"), target: resourceTarget }, returns: resourceView, handler: async (ctx, args) => resourceSummary(args.target, await authorizedResource(ctx, args.workspaceId, args.target)) });
