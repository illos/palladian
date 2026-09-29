import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import type { DataModel } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import authConfig from "./auth.config";
export const authComponent = createClient<DataModel>(components.betterAuth);
export function createAuth(ctx: GenericCtx<DataModel>, fixture = false) {
  const siteUrl = process.env.SITE_URL;
  const baseURL = process.env.CONVEX_SITE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!siteUrl || !baseURL || !secret || secret.length < 32)
    throw new Error("Auth configuration missing");
  if (
    fixture &&
    (!baseURL.startsWith("http://127.0.0.1:") ||
      process.env.NOTES_LOCAL_FIXTURES !== "1")
  )
    throw new Error("Fixtures require disposable local backend");
  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !fixture,
      minPasswordLength: 16,
    },
    session: {
      expiresIn: 31_536_000,
      updateAge: 86_400,
      cookieCache: { enabled: false },
    },
    plugins: [
      crossDomain({ siteUrl }),
      convex({
        authConfig,
        jwt: {
          expirationSeconds: process.env.NOTES_LOCAL_FIXTURES === "1" ? 5 : 900,
        },
      }),
    ],
  });
}
export const identity = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => (await authComponent.getAuthUser(ctx))._id,
});
export const fixture = internalMutation({
  args: { email: v.string(), password: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const result = await createAuth(ctx, true).api.signUpEmail({
      body: { ...args, name: "Disposable proof user" },
    });
    return result.user.id;
  },
});
