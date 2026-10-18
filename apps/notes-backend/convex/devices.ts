import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requireHuman } from "./access";
import { hashToken } from "./invitations";

/** A device secret: random, long, and known only to one browser. */
function validSecret(secret: string) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(secret);
}

/** Record that this browser has caught up with the account's resets. */
export async function bindDevice(
  ctx: MutationCtx,
  secret: string,
  principalId: Id<"principals">,
  resetEpoch: number,
) {
  const secretHash = await hashToken(secret);
  const existing = await ctx.db
    .query("devices")
    .withIndex("by_secret_hash_and_principal", (q) =>
      q.eq("secretHash", secretHash).eq("principalId", principalId),
    )
    .unique();
  const record = { resetEpoch, boundAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, record);
  else await ctx.db.insert("devices", { secretHash, principalId, ...record });
}

/**
 * For each account this browser holds copies of: whether a password reset
 * happened since it last caught up (D98). Only the holder of the secret can
 * ask, so the answer reveals nothing to anyone else.
 */
export const status = query({
  args: { secret: v.string() },
  returns: v.array(v.object({ accountId: v.string(), revoked: v.boolean() })),
  handler: async (ctx, args) => {
    if (!validSecret(args.secret)) return [];
    const secretHash = await hashToken(args.secret);
    const records = await ctx.db
      .query("devices")
      .withIndex("by_secret_hash_and_principal", (q) =>
        q.eq("secretHash", secretHash),
      )
      .take(20);
    const result = [];
    for (const record of records) {
      const person = await ctx.db.get(record.principalId);
      if (!person?.authUserId) continue;
      result.push({
        accountId: person.authUserId,
        revoked: record.resetEpoch < (person.resetEpoch ?? 0),
      });
    }
    return result;
  },
});

/**
 * The signed-in browser has no copies from before the last reset: either it
 * is new here or it has just cleared them. Called before the account opens.
 */
export const bind = mutation({
  args: { secret: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (!validSecret(args.secret)) return null;
    await bindDevice(ctx, args.secret, person._id, person.resetEpoch ?? 0);
    return null;
  },
});
