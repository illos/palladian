import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
export async function requireIdentity(ctx: QueryCtx) {
  const user = await authComponent.getAuthUser(ctx);
  const identity = await ctx.db
    .query("platformUsers")
    .withIndex("by_provider_subject", (q) =>
      q.eq("provider", "better-auth").eq("subject", user._id),
    )
    .unique();
  if (!identity) throw new ConvexError("UNAUTHENTICATED");
  return identity;
}
export const ensure = mutation({
  args: {},
  returns: v.id("platformUsers"),
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    const existing = await ctx.db
      .query("platformUsers")
      .withIndex("by_provider_subject", (q) =>
        q.eq("provider", "better-auth").eq("subject", user._id),
      )
      .unique();
    return (
      existing?._id ??
      (await ctx.db.insert("platformUsers", {
        provider: "better-auth",
        subject: user._id,
      }))
    );
  },
});
export const current = query({
  args: {},
  returns: v.union(v.null(), v.object({ id: v.id("platformUsers") })),
  handler: async (ctx) => {
    // A null result is an explicit live-session denial, never authorization from a cached JWT.
    if (!(await authComponent.safeGetAuthUser(ctx))) return null;
    const identity = await requireIdentity(ctx);
    return { id: identity._id };
  },
});
