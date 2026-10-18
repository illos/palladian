import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";
import { fail } from "./access";
import { authOptions } from "./auth";

const EXPIRED =
  "This reset link has expired or was already used. Request a new one.";

/**
 * Set a new password from an emailed reset link. Better Auth checks and
 * consumes the token and signs out every device (D25). Connected agents keep
 * their access or are disconnected as the person chose (D26), and only after
 * the reset has succeeded.
 */
export const reset = action({
  args: {
    token: v.string(),
    newPassword: v.string(),
    agents: v.union(v.literal("keep"), v.literal("disconnect")),
  },
  returns: v.object({ email: v.string(), agentsDisconnected: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ email: string; agentsDisconnected: number }> => {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(args.token)) fail("invalid", EXPIRED);
    if (args.newPassword.length < 12 || args.newPassword.length > 128)
      fail("invalid", "Choose a password of 12 to 128 characters.");
    // Whose token this is, read before Better Auth consumes it.
    const verification = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: "verification",
        where: [{ field: "identifier", value: `reset-password:${args.token}` }],
      },
    );
    if (!verification || verification.expiresAt <= Date.now())
      fail("invalid", EXPIRED);
    const authUserId: string = verification.value;
    try {
      await betterAuth(authOptions(ctx)).api.resetPassword({
        body: { token: args.token, newPassword: args.newPassword },
      });
    } catch {
      fail("invalid", EXPIRED);
    }
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: authUserId }],
    });
    if (!user) fail("invalid", EXPIRED);
    const agentsDisconnected =
      args.agents === "disconnect"
        ? await ctx.runMutation(internal.connections.disconnectAll, {
            authUserId,
          })
        : 0;
    return { email: user.email, agentsDisconnected };
  },
});
