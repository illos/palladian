import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { DefinitionId } from "../../packages/contracts/src/index";
import { requireIdentity } from "./identity";
import { fail } from "./errors";
export async function requirePlatformIdentity(ctx: QueryCtx) {
  try {
    return await requireIdentity(ctx);
  } catch (error) {
    // Normalize only the pinned P1 adapter's explicit unauthenticated errors.
    // Transport and unexpected failures are not authority to change sessions.
    if (
      error instanceof ConvexError &&
      (error.data === "Unauthenticated" || error.data === "UNAUTHENTICATED")
    )
      fail("UNAUTHENTICATED");
    throw error;
  }
}
export async function requireWorkspace(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
) {
  const identity = await requirePlatformIdentity(ctx);
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace || workspace.ownerId !== identity._id) fail("NOT_FOUND");
  return { identity, workspace };
}
export async function requireInstance(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; instanceId: Id<"appInstances"> },
  options: { includeArchived?: boolean; definitionId?: DefinitionId } = {},
) {
  const scope = await requireWorkspace(ctx, args.workspaceId);
  const instance = await ctx.db.get(args.instanceId);
  if (
    !instance ||
    instance.workspaceId !== scope.workspace._id ||
    (options.definitionId !== undefined &&
      instance.definitionId !== options.definitionId) ||
    (!options.includeArchived && instance.lifecycle !== "active")
  )
    fail("NOT_FOUND");
  return { ...scope, instance };
}
export function requireAppInstance(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; instanceId: Id<"appInstances"> },
  definitionId: DefinitionId,
) {
  return requireInstance(ctx, args, { definitionId });
}
export async function requirePreferences(
  ctx: QueryCtx,
  scope: { workspace: Doc<"workspaces">; instance: Doc<"appInstances"> },
  preferencesId: Id<"instancePreferences">,
) {
  const preferences = await ctx.db.get(preferencesId);
  if (
    !preferences ||
    preferences.instanceId !== scope.instance._id ||
    preferences.workspaceId !== scope.workspace._id ||
    preferences.workspaceId !== scope.instance.workspaceId
  )
    fail("NOT_FOUND");
  return preferences;
}
