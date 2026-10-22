import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { fail, requireHuman, type Principal } from "./access";

/**
 * The devices signed in to a person's account: their Better Auth sessions,
 * listed and ended by ID. Session tokens never leave the server. Ending a
 * session takes effect at once: every Convex call checks that its session
 * still exists, and the device's next session check asks it to sign in again.
 */

const device = v.object({
  id: v.string(),
  label: v.string(),
  signedInAt: v.number(),
  lastActiveAt: v.number(),
  current: v.boolean(),
});

interface SessionRow {
  _id: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  userAgent?: string | null;
}

const PAGE = 100;

/** Every unexpired session of the person, read a page at a time. */
async function sessionsOf(
  ctx: QueryCtx | MutationCtx,
  person: Principal,
): Promise<SessionRow[]> {
  if (!person.authUserId)
    fail("denied", "Only people can perform this action.");
  const now = Date.now();
  const rows: SessionRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: {
      page: SessionRow[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: person.authUserId }],
      paginationOpts: { numItems: PAGE, cursor },
    });
    rows.push(...result.page.filter((row) => row.expiresAt > now));
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
}

/** The session the caller is using, from its token's claims. */
async function currentSession(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  return typeof identity?.sessionId === "string" ? identity.sessionId : null;
}

/** "iPhone · Safari" from a browser's user agent; never the raw string. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : // Home Screen apps on iPhone and iPad omit the Safari token.
            system === "iPhone" || system === "iPad"
            ? "Home Screen app"
            : null;
  if (!system && !browser) return "Unknown device";
  return [system, browser].filter(Boolean).join(" · ");
}

export const list = query({
  args: {},
  returns: v.array(device),
  handler: async (ctx) => {
    const person = await requireHuman(ctx);
    const current = await currentSession(ctx);
    const rows = await sessionsOf(ctx, person);
    return rows
      .sort(
        (a, b) =>
          Number(b._id === current) - Number(a._id === current) ||
          b.updatedAt - a.updatedAt,
      )
      .map((row) => ({
        id: row._id,
        label: deviceLabel(row.userAgent),
        signedInAt: row.createdAt,
        lastActiveAt: row.updatedAt,
        current: row._id === current,
      }));
  },
});

/** Sign one other device out. This device signs out through the app. */
export const revoke = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (args.id === (await currentSession(ctx)))
      fail("invalid", "Use Sign out to sign this device out.");
    const row = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session",
      where: [{ field: "_id", value: args.id }],
    })) as SessionRow | null;
    if (!row || row.userId !== person.authUserId)
      fail("not_found", "That device is already signed out.");
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "session", where: [{ field: "_id", value: row._id }] },
    });
    return null;
  },
});

/** Sign out every device except this one; returns how many were signed out. */
export const revokeOthers = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const person = await requireHuman(ctx);
    const current = await currentSession(ctx);
    if (!current) fail("unauthenticated", "Sign in to continue.");
    const others = (await sessionsOf(ctx, person)).filter(
      (row) => row._id !== current,
    );
    for (const row of others)
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "session", where: [{ field: "_id", value: row._id }] },
      });
    return others.length;
  },
});
