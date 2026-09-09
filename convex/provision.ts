import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { authOptions } from "./auth";
// Operator-only Convex invocation; no public HTTP route or frontend bootstrap credential.
export const owner = internalAction({
  args: { email: v.string(), password: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.name.length < 1 || args.name.length > 100)
      throw new Error("Invalid owner name");
    const options = authOptions(ctx);
    const auth = betterAuth({
      ...options,
      emailAndPassword: {
        ...options.emailAndPassword,
        disableSignUp: false,
        autoSignIn: false,
      },
    });
    // Library validation, password hashing, and credential account creation. No returned session.
    await auth.api.signUpEmail({ body: args });
    return null;
  },
});
