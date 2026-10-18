import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { passkeys } from "./betterAuth/options";
import authSchema from "./betterAuth/schema";
import { requireAuthSecret, requireFrontendOrigin } from "./config";

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  { local: { schema: authSchema } },
);

export function authOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = requireFrontendOrigin(process.env.SITE_URL);
  const baseURL = process.env.CONVEX_SITE_URL;
  if (!baseURL) throw new Error("CONVEX_SITE_URL is not available.");
  return {
    baseURL,
    secret: requireAuthSecret(process.env.BETTER_AUTH_SECRET),
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    logger: { disabled: true },
    disabledPaths: [
      "/cross-domain/one-time-token/verify",
      "/sign-in/social",
      // Resets go through passwords.reset, which applies the agent choice.
      "/reset-password",
    ],
    emailAndPassword: {
      enabled: true,
      // Accounts come only from invitations; see invitations.ts.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      // A successful reset signs out every device (D25).
      revokeSessionsOnPasswordReset: true,
      // Scheduling keeps the response the same whether or not the account
      // exists; the send itself is rate limited in email.ts.
      sendResetPassword: async ({ user, token }) => {
        if (!("scheduler" in ctx) || !("runAction" in ctx))
          throw new Error("Password reset requests run in an action.");
        await ctx.scheduler.runAfter(0, internal.email.sendPasswordReset, {
          userId: user.id,
          to: user.email,
          token,
        });
      },
    },
    // Year-scale sliding sessions: ordinary use never requires weekly sign-in.
    session: {
      expiresIn: 31_536_000,
      updateAge: 86_400,
      freshAge: 86_400,
      cookieCache: { enabled: false },
    },
    plugins: [
      crossDomain({ siteUrl }),
      passkeys(siteUrl),
      convex({
        authConfig,
        jwt: { expirationSeconds: 900, definePayload: () => ({}) },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(authOptions(ctx));
