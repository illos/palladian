import {
  createClient,
  type AuthFunctions,
  type GenericCtx,
} from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { ConvexError } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { passkeys, sessionFields } from "./betterAuth/options";
import authSchema from "./betterAuth/schema";
import { requireAuthSecret, requireFrontendOrigin } from "./config";

// Typed separately: the triggers below are exported from this same module.
const authFunctions: AuthFunctions = internal.auth;

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  {
    local: { schema: authSchema },
    authFunctions,
    triggers: {
      session: {
        // Runs in the transaction that writes the session: a password reset
        // committed since the sign-in verified the password refuses it (D98).
        onCreate: async (ctx, session) => {
          if (typeof session.credentialEpoch !== "number") return;
          const person = await ctx.db
            .query("principals")
            .withIndex("by_auth_user", (q) =>
              q.eq("authUserId", session.userId),
            )
            .unique();
          if ((person?.resetEpoch ?? 0) !== session.credentialEpoch)
            throw new ConvexError({
              code: "invalid",
              message: "The password changed while signing in. Sign in again.",
            });
        },
      },
    },
  },
);

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

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
      additionalFields: sessionFields,
    },
    databaseHooks: {
      session: {
        create: {
          /**
           * A password sign-in may have verified the old password just before
           * a reset. Read the reset count first, then check the password again
           * against the current credential: a reset between the two fails the
           * check, and one after it changes the count, which the session
           * trigger compares when the session is written.
           */
          before: async (session, context) => {
            if (context?.path !== "/sign-in/email") return;
            if (!("runQuery" in ctx))
              throw new Error("Password sign-in runs in an action.");
            const credentialEpoch = await ctx.runQuery(
              internal.passwords.resetEpoch,
              { authUserId: session.userId },
            );
            const body: unknown = context.body;
            const password =
              body && typeof body === "object" && "password" in body
                ? body.password
                : undefined;
            const credential = (
              await context.context.internalAdapter.findAccounts(session.userId)
            ).find((account) => account.providerId === "credential");
            if (
              typeof password !== "string" ||
              !credential?.password ||
              !(await context.context.password.verify({
                hash: credential.password,
                password,
              }))
            )
              throw new APIError("UNAUTHORIZED", {
                message: "Invalid email or password",
              });
            return { data: { ...session, credentialEpoch } };
          },
        },
      },
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
