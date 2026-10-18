import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { relay, siteLink } from "./email";
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

/** Operator-only: email a new setup link instead of handing it over. */
export const emailOwnerSetup = internalAction({
  args: { email: v.string() },
  returns: v.object({ sent: v.boolean(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ sent: boolean; expiresAt: number }> => {
    const { token, expiresAt } = await ctx.runMutation(
      internal.provision.setupOwner,
      { email: args.email },
    );
    const sent = await relay({
      kind: "invite",
      to: normalizeEmail(args.email),
      url: siteLink("/invite", token),
      inviterName: null,
      target: null,
    });
    return { sent, expiresAt };
  },
});
