import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { fail, requireHuman } from "./access";
import { hashToken } from "./invitations";

/** Browsers recorded per account; the oldest current one is retired first. */
const MAX_DEVICES = 200;

/** A device secret: random, long, and known only to one browser. */
export function validSecret(secret: string) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(secret);
}

async function recordFor(
  ctx: QueryCtx,
  secretHash: string,
  person: Doc<"principals">,
) {
  return ctx.db
    .query("devices")
    .withIndex("by_secret_hash_and_principal", (q) =>
      q.eq("secretHash", secretHash).eq("principalId", person._id),
    )
    .unique();
}

/**
 * Record that this browser holds no copies of the account from before its
 * last reset. Over the limit, the longest-recorded browser that owes no
 * clean-up is retired (it is then unknown, and a browser unknown here must
 * clear any copies before it opens); browsers behind a reset are kept.
 */
async function bindDevice(
  ctx: MutationCtx,
  secret: string,
  person: Doc<"principals">,
) {
  const secretHash = await hashToken(secret);
  const resetEpoch = person.resetEpoch ?? 0;
  const existing = await recordFor(ctx, secretHash, person);
  if (existing) {
    await ctx.db.patch(existing._id, { resetEpoch, boundAt: Date.now() });
    return;
  }
  const records = await ctx.db
    .query("devices")
    .withIndex("by_principal", (q) => q.eq("principalId", person._id))
    .take(MAX_DEVICES);
  if (records.length >= MAX_DEVICES) {
    const retired = records
      .filter((record) => record.resetEpoch >= resetEpoch)
      .sort((a, b) => a.boundAt - b.boundAt)[0];
    if (!retired)
      fail("invalid", "Too many browsers are registered for this account.");
    await ctx.db.delete(retired._id);
  }
  await ctx.db.insert("devices", {
    secretHash,
    principalId: person._id,
    resetEpoch,
    boundAt: Date.now(),
  });
}

/**
 * The resetting browser is not revoked by its own reset (D98), but keeps any
 * clean-up it still owes for an earlier one; an unknown browser stays unknown.
 * Called inside the reset transaction, after the count was incremented.
 */
export async function exemptResettingDevice(
  ctx: MutationCtx,
  secret: string,
  person: Doc<"principals">,
  previousEpoch: number,
) {
  if (!validSecret(secret)) return;
  const record = await recordFor(ctx, await hashToken(secret), person);
  if (record && record.resetEpoch >= previousEpoch)
    await ctx.db.patch(record._id, {
      resetEpoch: previousEpoch + 1,
      boundAt: Date.now(),
    });
}

/**
 * Whether this browser is recorded for the account and, if so, whether a
 * password reset happened since it caught up (D98). Only the holder of the
 * secret can ask, so the answer tells nobody else anything.
 */
export const status = query({
  args: { secret: v.string(), accountId: v.string() },
  returns: v.object({ known: v.boolean(), behind: v.boolean() }),
  handler: async (ctx, args) => {
    const unknown = { known: false, behind: false };
    if (!validSecret(args.secret) || args.accountId.length > 64) return unknown;
    const person = await ctx.db
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", args.accountId))
      .unique();
    if (!person) return unknown;
    const record = await recordFor(ctx, await hashToken(args.secret), person);
    if (!record) return unknown;
    return {
      known: true,
      behind: record.resetEpoch < (person.resetEpoch ?? 0),
    };
  },
});

/**
 * The signed-in browser holds no copies of this account from before its last
 * reset: it is new here, or has cleared them. Called before the account opens.
 */
export const bind = mutation({
  args: { secret: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (!validSecret(args.secret)) fail("invalid", "Invalid device.");
    await bindDevice(ctx, args.secret, person);
    return null;
  },
});
