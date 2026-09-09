import { v, ConvexError } from "convex/values";
import { query, action } from "../_generated/server";
import { components } from "../_generated/api";
import { authComponent, createAuth } from "../auth";
const sessionView = v.object({
  id: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
  current: v.boolean(),
});
export const list = query({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(sessionView),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor }) => {
    const user = await authComponent.getAuthUser(ctx);
    const identity = await ctx.auth.getUserIdentity();
    const result: {
      page: { _id: string; createdAt: number; expiresAt: number }[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: user._id }],
      paginationOpts: { cursor, numItems: 25 },
    });
    return {
      ...result,
      page: result.page.map((s) => ({
        id: s._id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: s._id === identity?.sessionId,
      })),
    };
  },
});
export const revoke = action({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const user = await authComponent.getAuthUser(ctx);
    const session: { userId: string; token: string } | null =
      await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", value: id }],
      });
    if (!session || session.userId !== user._id)
      throw new ConvexError("NOT_FOUND");
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
    await auth.api.revokeSession({ headers, body: { token: session.token } });
    return null;
  },
});
