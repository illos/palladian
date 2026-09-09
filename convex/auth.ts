import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { requireAuthSecret, requireFrontendOrigin } from "./platform/config";
export const authComponent = createClient<DataModel>(components.betterAuth);
export function authOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = requireFrontendOrigin(process.env.SITE_URL);
  const baseURL = process.env.CONVEX_SITE_URL;
  if (!baseURL) throw new Error("Auth HTTP origin configuration missing");
  return {
    baseURL,
    secret: requireAuthSecret(process.env.BETTER_AUTH_SECRET),
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    logger: { disabled: true },
    disabledPaths: ["/cross-domain/one-time-token/verify", "/sign-in/social"],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 16,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 31_536_000,
      updateAge: 86_400,
      freshAge: 86_400,
      cookieCache: { enabled: false },
    },
    plugins: [
      crossDomain({ siteUrl }),
      convex({
        authConfig,
        jwt: { expirationSeconds: 900, definePayload: () => ({}) },
      }),
    ],
  } satisfies BetterAuthOptions;
}
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(authOptions(ctx));
