import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { requireFrontendOrigin } from "./config";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Per subject (an account or an invitation). */
const PER_HOUR = 3;
/** Overall; Cloudflare includes 3,000 sends a month. */
const PER_DAY = 100;

export type RelayMessage =
  | { kind: "reset"; to: string; url: string }
  | {
      kind: "invite";
      to: string;
      url: string;
      inviterName: string | null;
      target: string | null;
    };

/**
 * Hand a message to the Worker, which holds the Cloudflare email binding and
 * renders the templates (apps/notes-edge/src/email.ts). Never logs the
 * recipient or link.
 */
export async function relay(message: RelayMessage): Promise<boolean> {
  const secret = process.env.EMAIL_RELAY_SECRET;
  if (!secret) {
    console.warn("Account email is not configured.");
    return false;
  }
  const site = requireFrontendOrigin(process.env.SITE_URL);
  try {
    const response = await fetch(`${site}/internal/email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
    if (!response.ok)
      console.error("Account email failed", {
        kind: message.kind,
        status: response.status,
      });
    return response.ok;
  } catch {
    console.error("Account email relay unreachable", { kind: message.kind });
    return false;
  }
}

export function siteLink(path: "/reset" | "/invite", token: string) {
  return `${requireFrontendOrigin(process.env.SITE_URL)}${path}#${token}`;
}

/** Reserve one send for `key`, within the hourly and daily limits. */
export const reserve = internalMutation({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("emailSends")
      .withIndex("by_key_and_created_at", (q) =>
        q.eq("key", args.key).gt("createdAt", now - HOUR),
      )
      .take(PER_HOUR);
    if (recent.length >= PER_HOUR) return false;
    const today = await ctx.db
      .query("emailSends")
      .withIndex("by_created_at", (q) => q.gt("createdAt", now - DAY))
      .take(PER_DAY);
    if (today.length >= PER_DAY) return false;
    await ctx.db.insert("emailSends", { key: args.key, createdAt: now });
    return true;
  },
});

export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("emailSends")
      .withIndex("by_created_at", (q) =>
        q.lt("createdAt", Date.now() - 2 * DAY),
      )
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === 500)
      await ctx.scheduler.runAfter(0, internal.email.prune, {});
    return null;
  },
});

/** Scheduled by Better Auth's reset request; see auth.ts. */
export const sendPasswordReset = internalAction({
  args: { userId: v.string(), to: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const allowed = await ctx.runMutation(internal.email.reserve, {
      key: `reset:${args.userId}`,
    });
    if (allowed)
      await relay({
        kind: "reset",
        to: args.to,
        url: siteLink("/reset", args.token),
      });
    return null;
  },
});
