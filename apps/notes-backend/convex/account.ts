import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, getPrincipal, requireHuman } from "./access";

export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("principals"),
      kind: v.union(v.literal("human"), v.literal("agent")),
      name: v.string(),
      email: v.union(v.string(), v.null()),
      defaultNotebookId: v.union(v.id("notebooks"), v.null()),
      trashRetentionDays: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    return {
      id: principal._id,
      kind: principal.kind,
      name: principal.name,
      email: principal.email ?? null,
      defaultNotebookId: principal.defaultNotebookId ?? null,
      trashRetentionDays: principal.trashRetentionDays ?? 30,
    };
  },
});

/**
 * Whether the account's password was reset after `since`, when a device's
 * session began. Asked by a device whose session is gone, so it cannot be
 * authenticated: the answer is one bit about an opaque account id the device
 * already holds. True means the device was revoked and clears its copies (D98).
 */
export const resetSince = query({
  args: { accountId: v.string(), since: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (args.accountId.length > 64 || !Number.isFinite(args.since))
      return false;
    const person = await ctx.db
      .query("principals")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", args.accountId))
      .unique();
    return (person?.passwordResetAt ?? 0) > args.since;
  },
});

export const rename = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const name = args.name.trim();
    if (!name || name.length > 100) fail("invalid", "Enter a name.");
    await ctx.db.patch(person._id, { name });
    return null;
  },
});
