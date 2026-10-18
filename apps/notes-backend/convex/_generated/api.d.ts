/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as account from "../account.js";
import type * as auth from "../auth.js";
import type * as config from "../config.js";
import type * as connections from "../connections.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as email from "../email.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as library from "../library.js";
import type * as lifecycle from "../lifecycle.js";
import type * as notebooks from "../notebooks.js";
import type * as notes from "../notes.js";
import type * as passwords from "../passwords.js";
import type * as provision from "../provision.js";
import type * as publishing from "../publishing.js";
import type * as sharing from "../sharing.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  account: typeof account;
  auth: typeof auth;
  config: typeof config;
  connections: typeof connections;
  crons: typeof crons;
  documents: typeof documents;
  email: typeof email;
  history: typeof history;
  http: typeof http;
  invitations: typeof invitations;
  library: typeof library;
  lifecycle: typeof lifecycle;
  notebooks: typeof notebooks;
  notes: typeof notes;
  passwords: typeof passwords;
  provision: typeof provision;
  publishing: typeof publishing;
  sharing: typeof sharing;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
