/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apps_notes_instances from "../apps/notes/instances.js";
import type * as apps_recipes_instances from "../apps/recipes/instances.js";
import type * as auth from "../auth.js";
import type * as http from "../http.js";
import type * as platform_config from "../platform/config.js";
import type * as platform_errors from "../platform/errors.js";
import type * as platform_fileRecords from "../platform/fileRecords.js";
import type * as platform_fileValues from "../platform/fileValues.js";
import type * as platform_fixtures from "../platform/fixtures.js";
import type * as platform_identity from "../platform/identity.js";
import type * as platform_instances from "../platform/instances.js";
import type * as platform_preferences from "../platform/preferences.js";
import type * as platform_registry from "../platform/registry.js";
import type * as platform_resources from "../platform/resources.js";
import type * as platform_routes from "../platform/routes.js";
import type * as platform_scope from "../platform/scope.js";
import type * as platform_search from "../platform/search.js";
import type * as platform_sessions from "../platform/sessions.js";
import type * as platform_values from "../platform/values.js";
import type * as platform_views from "../platform/views.js";
import type * as platform_workspaces from "../platform/workspaces.js";
import type * as provision from "../provision.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "apps/notes/instances": typeof apps_notes_instances;
  "apps/recipes/instances": typeof apps_recipes_instances;
  auth: typeof auth;
  http: typeof http;
  "platform/config": typeof platform_config;
  "platform/errors": typeof platform_errors;
  "platform/fileRecords": typeof platform_fileRecords;
  "platform/fileValues": typeof platform_fileValues;
  "platform/fixtures": typeof platform_fixtures;
  "platform/identity": typeof platform_identity;
  "platform/instances": typeof platform_instances;
  "platform/preferences": typeof platform_preferences;
  "platform/registry": typeof platform_registry;
  "platform/resources": typeof platform_resources;
  "platform/routes": typeof platform_routes;
  "platform/scope": typeof platform_scope;
  "platform/search": typeof platform_search;
  "platform/sessions": typeof platform_sessions;
  "platform/values": typeof platform_values;
  "platform/views": typeof platform_views;
  "platform/workspaces": typeof platform_workspaces;
  provision: typeof provision;
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
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
