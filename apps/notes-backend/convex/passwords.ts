import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { fail } from "./access";
import { authOptions } from "./auth";
import { disconnectAgents } from "./connections";
import { exemptResettingDevice } from "./devices";

const EXPIRED =
  "This reset link has expired or was already used. Request a new one.";
const agentChoice = v.union(v.literal("keep"), v.literal("disconnect"));
const resetResult = v.object({
  email: v.string(),
  agentsDisconnected: v.number(),
});
type ResetResult = { email: string; agentsDisconnected: number };

/**
 * Set a new password from an emailed reset link. Better Auth issues the link
 * and hashes the password; everything a successful reset changes then
 * commits in one transaction (finishReset), so it cannot half-apply.
 */
export const reset = action({
  args: {
    token: v.string(),
    newPassword: v.string(),
    agents: agentChoice,
    // The browser making the reset keeps its copies (D98 revokes the others).
    device: v.optional(v.string()),
  },
  returns: resetResult,
  handler: async (ctx, args): Promise<ResetResult> => {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(args.token)) fail("invalid", EXPIRED);
    if (args.newPassword.length < 12 || args.newPassword.length > 128)
      fail("invalid", "Choose a password of 12 to 128 characters.");
    // Hashing is slow and needs no database, so it stays outside the transaction.
    const auth = betterAuth(authOptions(ctx));
    const hash = await (await auth.$context).password.hash(args.newPassword);
    return await ctx.runMutation(internal.passwords.finishReset, {
      token: args.token,
      hash,
      agents: args.agents,
      ...(args.device ? { device: args.device } : {}),
    });
  },
});

/**
 * One transaction: consume the link, set the password, end every session of
 * the account (D25), count the reset so other browsers clear their copies and
 * in-flight sign-ins with the old password fail (D98, auth.ts) while this
 * browser stays current, and, if the person chose to, disconnect their agents
 * (D26). If any step fails nothing changes and the link still works.
 */
export const finishReset = internalMutation({
  args: {
    token: v.string(),
    hash: v.string(),
    agents: agentChoice,
    device: v.optional(v.string()),
  },
  returns: resetResult,
  handler: async (ctx, args) => {
    const now = Date.now();
    const verification = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: "verification",
        where: [{ field: "identifier", value: `reset-password:${args.token}` }],
      },
    );
    if (!verification || verification.expiresAt <= now)
      fail("invalid", EXPIRED);
    const userId: string = verification.value;
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: userId }],
    });
    if (!user) fail("invalid", EXPIRED);
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "verification",
        where: [{ field: "_id", value: verification._id }],
      },
    });
    const credential = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: "account",
        where: [
          { field: "userId", value: userId },
          { field: "providerId", value: "credential" },
        ],
      },
    );
    if (credential)
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "account",
          where: [{ field: "_id", value: credential._id }],
          update: { password: args.hash, updatedAt: now },
        },
      });
    else
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "account",
          data: {
            userId,
            providerId: "credential",
            accountId: userId,
            password: args.hash,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
    let cursor: string | null = null;
    for (;;) {
      const page: { isDone: boolean; continueCursor: string } =
        await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
          input: {
            model: "session",
            where: [{ field: "userId", value: userId }],
          },
          paginationOpts: { numItems: 100, cursor },
        });
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const person = await ctx.db
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", userId))
      .unique();
    if (person) {
      const previousEpoch = person.resetEpoch ?? 0;
      await ctx.db.patch(person._id, { resetEpoch: previousEpoch + 1 });
      if (args.device)
        await exemptResettingDevice(ctx, args.device, person, previousEpoch);
    }
    const agentsDisconnected =
      args.agents === "disconnect" ? await disconnectAgents(ctx, userId) : 0;
    return { email: user.email, agentsDisconnected };
  },
});

/** The account's password-reset count, read by password sign-ins (auth.ts). */
export const resetEpoch = internalQuery({
  args: { authUserId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const person = await ctx.db
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", args.authUserId))
      .unique();
    return person?.resetEpoch ?? 0;
  },
});
