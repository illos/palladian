import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireInstance, requirePlatformIdentity } from "./scope";
import { instanceView as validator } from "./values";
import { instanceView } from "./views";
import { fail } from "./errors";
import { instanceHref } from "../../packages/contracts/src/routes";
export const resolveInstance = query({
  args: {
    instanceId: v.id("appInstances"),
    workspaceId: v.optional(v.id("workspaces")),
    presentation: v.union(v.literal("integrated"), v.literal("standalone")),
  },
  returns: v.object({ instance: validator, href: v.string() }),
  handler: async (ctx, args) => {
    await requirePlatformIdentity(ctx);
    const instance = await ctx.db.get(args.instanceId);
    if (
      !instance ||
      (args.workspaceId !== undefined &&
        args.workspaceId !== instance.workspaceId)
    )
      fail("NOT_FOUND");
    const authorized = await requireInstance(ctx, {
      workspaceId: instance.workspaceId,
      instanceId: instance._id,
    });
    return {
      instance: instanceView(authorized.instance),
      href: instanceHref(instance.workspaceId, instance._id, args.presentation),
    };
  },
});
