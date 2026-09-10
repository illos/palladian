import { v } from "convex/values";
export const definitionId = v.union(v.literal("notes"), v.literal("recipes"));
export const lifecycle = v.union(v.literal("active"), v.literal("archived"));
export const theme = v.union(
  v.literal("light"),
  v.literal("dark"),
  v.literal("system"),
);
export const density = v.union(v.literal("comfortable"), v.literal("compact"));
export const workspaceView = v.object({
  id: v.id("workspaces"),
  title: v.string(),
  revision: v.number(),
  theme,
});
export const instanceView = v.object({
  id: v.id("appInstances"),
  workspaceId: v.id("workspaces"),
  definitionId,
  title: v.string(),
  lifecycle,
  revision: v.number(),
  preferencesVersion: v.number(),
  sortOrder: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export const preferencesView = v.object({
  id: v.id("instancePreferences"),
  workspaceId: v.id("workspaces"),
  instanceId: v.id("appInstances"),
  density,
  revision: v.number(),
});
export const instanceScopeArgs = {
  workspaceId: v.id("workspaces"),
  instanceId: v.id("appInstances"),
};
export const preferencesUpdateArgs = {
  ...instanceScopeArgs,
  preferencesId: v.id("instancePreferences"),
  expectedRevision: v.number(),
  density,
};
