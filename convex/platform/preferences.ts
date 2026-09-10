import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { fail, nextRevision, revision } from "./errors";
import { preferencesView } from "./views";
export async function readPreferences(
  ctx: QueryCtx,
  scope: { instance: Doc<"appInstances">; workspace: Doc<"workspaces"> },
) {
  const preferences = await ctx.db
    .query("instancePreferences")
    .withIndex("by_instance", (q) => q.eq("instanceId", scope.instance._id))
    .unique();
  if (
    !preferences ||
    preferences.workspaceId !== scope.workspace._id ||
    preferences.workspaceId !== scope.instance.workspaceId
  )
    fail("NOT_FOUND");
  return preferencesView(preferences);
}
export async function setDensity(
  ctx: MutationCtx,
  instance: Doc<"appInstances">,
  preferences: Doc<"instancePreferences">,
  args: { expectedRevision: number; density: "comfortable" | "compact" },
) {
  revision(args.expectedRevision);
  if (preferences.revision !== args.expectedRevision) fail("CONFLICT");
  if (preferences.revision !== instance.preferencesVersion) fail("TEMPORARY");
  const next = {
    density: args.density,
    revision: nextRevision(preferences.revision),
  };
  await ctx.db.patch(preferences._id, next);
  await ctx.db.patch(instance._id, { preferencesVersion: next.revision });
  return preferencesView({ ...preferences, ...next });
}
