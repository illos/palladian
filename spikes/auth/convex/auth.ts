import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const baseURL = process.env.CONVEX_SITE_URL;
  // This fixture-only spike deliberately cannot run on a hosted deployment.
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1") {
    throw new Error("Auth spike requires isolated loopback deployment");
  }
  return betterAuth({
    baseURL,
    trustedOrigins: ["http://localhost:5173"],
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: { expiresIn: 365 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    plugins: [crossDomain({ siteUrl: "http://localhost:5173" }), convex({ authConfig, jwt: { expirationSeconds: 900, definePayload: () => ({}) } })],
  });
};
// Return only a boolean: the probe never needs to print identity or session data.
export const protectedProbe = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => { await authComponent.getAuthUser(ctx); return true; },
});
