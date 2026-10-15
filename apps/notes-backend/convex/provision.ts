import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { hashToken, newToken, normalizeEmail } from "./invitations";

const SETUP_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Operator-only: create a single-use account setup link for the owner. The
 * owner chooses their own password; no credential passes through the operator.
 */
export const setupOwner = internalMutation({
  args: { email: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const token = newToken();
    const now = Date.now();
    await ctx.db.insert("invitations", {
      email,
      tokenHash: await hashToken(token),
      expiresAt: now + SETUP_TTL_MS,
      createdAt: now,
    });
    return { token, expiresAt: now + SETUP_TTL_MS };
  },
});
