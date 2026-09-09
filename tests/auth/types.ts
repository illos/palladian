import { authClient } from "../../apps/web/src/auth/client";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
type Assert<T extends true> = T;
type Reject<T extends false> = T;
type SignIn = Parameters<typeof authClient.signIn.email>[0];
type SessionOptions = NonNullable<Parameters<typeof authClient.getSession>[0]>;
type FetchOptions = NonNullable<SessionOptions["fetchOptions"]>;
export type PasswordRemainsRequired = Reject<
  { email: string } extends SignIn ? true : false
>;
export type PasswordRemainsString = Reject<
  { email: string; password: number } extends SignIn ? true : false
>;
export type UndefinedOptionalFetchValue = Assert<
  { cache: undefined } extends FetchOptions ? true : false
>;
export type InvalidCacheValueStillRejected = Reject<
  { cache: "invalid-mode" } extends FetchOptions ? true : false
>;
export type IdentityRemainsGenerated = Assert<
  FunctionReturnType<
    typeof api.platform.identity.ensure
  > extends Id<"platformUsers">
    ? true
    : false
>;
export type IdentityDoesNotAcceptPlainStrings = Reject<
  string extends FunctionReturnType<typeof api.platform.identity.ensure>
    ? true
    : false
>;
