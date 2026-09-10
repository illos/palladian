import { query, mutation } from "../../_generated/server";
import { requireAppInstance, requirePreferences } from "../../platform/scope";
import { appDefinitions } from "../../platform/registry";
import {
  instanceScopeArgs,
  preferencesUpdateArgs,
  preferencesView,
} from "../../platform/values";
import { readPreferences, setDensity } from "../../platform/preferences";
const registration = appDefinitions.recipes;
export const preferences = query({
  args: instanceScopeArgs,
  returns: preferencesView,
  handler: async (ctx, args) =>
    readPreferences(ctx, await requireAppInstance(ctx, args, registration.id)),
});
export const setPreferences = mutation({
  args: preferencesUpdateArgs,
  returns: preferencesView,
  handler: async (ctx, args) => {
    const scope = await requireAppInstance(ctx, args, registration.id);
    const preferences = await requirePreferences(
      ctx,
      scope,
      args.preferencesId,
    );
    return setDensity(ctx, scope.instance, preferences, args);
  },
});
