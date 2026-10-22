import { v } from "convex/values";
import { components } from "./_generated/api";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
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

/** Sessions examined by one list page. */
const PAGE_LIMIT = 100;
/** Sessions examined by one "sign out all other devices" call. */
const BATCH = 100;

function authUser(person: Principal): string {
  if (!person.authUserId)
    fail("denied", "Only people can perform this action.");
  return person.authUserId;
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

/**
 * One page of the person's devices, newest sign-ins first, read through the
 * session table's `userId` index so other people's sessions are never read.
 * Expired sessions are skipped within the page. The first page puts this
 * device first, even when it signed in long ago; later pages leave it out.
 */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(device),
  handler: async (ctx, args) => {
    const userId = authUser(await requireHuman(ctx));
    const current = await currentSession(ctx);
    const now = Date.now();
    const first = args.paginationOpts.cursor === null;
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: userId }],
      sortBy: { field: "createdAt", direction: "desc" },
      // The whole options pass through, including the end bound the client
      // pins on loaded pages, so they stay stable as devices come and go.
      paginationOpts: {
        ...args.paginationOpts,
        numItems: Math.min(
          Math.max(args.paginationOpts.numItems, 1),
          PAGE_LIMIT,
        ),
      },
    })) as {
      page: SessionRow[];
      isDone: boolean;
      continueCursor: string;
      splitCursor?: string | null;
      pageStatus?: "SplitRecommended" | "SplitRequired" | null;
    };
    const rows = result.page.filter(
      (row) => row.expiresAt > now && row._id !== current,
    );
    if (first && current) {
      const own = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", value: current }],
      })) as SessionRow | null;
      if (own && own.userId === userId && own.expiresAt > now)
        rows.unshift(own);
    }
    return {
      page: rows.map((row) => ({
        id: row._id,
        label: deviceLabel(row.userAgent),
        signedInAt: row.createdAt,
        lastActiveAt: row.updatedAt,
        current: row._id === current,
      })),
      isDone: result.isDone,
      // A bounded page always ends at its requested end. When the read limit
      // cuts it short (SplitRequired), the adapter reports where it stopped;
      // the client then splits the page between its start and this end, so
      // the rows after the cut are fetched rather than lost.
      continueCursor: args.paginationOpts.endCursor ?? result.continueCursor,
      ...(result.splitCursor !== undefined
        ? { splitCursor: result.splitCursor }
        : {}),
      ...(result.pageStatus !== undefined
        ? { pageStatus: result.pageStatus }
        : {}),
    };
  },
});

/** Sign one other device out. This device signs out through the app. */
export const revoke = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = authUser(await requireHuman(ctx));
    if (args.id === (await currentSession(ctx)))
      fail("invalid", "Use Sign out to sign this device out.");
    const row = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session",
      where: [{ field: "_id", value: args.id }],
    })) as SessionRow | null;
    if (!row || row.userId !== userId)
      fail("not_found", "That device is already signed out.");
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "session", where: [{ field: "_id", value: row._id }] },
    });
    return null;
  },
});

/**
 * Sign out other devices, one bounded batch per call: the caller repeats until
 * `done`. Expired sessions met on the way are removed too; `revoked` counts
 * only devices that were still signed in. This device is never touched.
 */
export const revokeOthers = mutation({
  args: {},
  returns: v.object({ revoked: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const userId = authUser(await requireHuman(ctx));
    const current = await currentSession(ctx);
    if (!current) fail("unauthenticated", "Sign in to continue.");
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: userId }],
      paginationOpts: { numItems: BATCH, cursor: null },
    })) as { page: SessionRow[]; isDone: boolean };
    const now = Date.now();
    let revoked = 0;
    for (const row of result.page) {
      if (row._id === current) continue;
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "session", where: [{ field: "_id", value: row._id }] },
      });
      if (row.expiresAt > now) revoked++;
    }
    return { revoked, done: result.isDone };
  },
});
