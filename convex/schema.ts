import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { definitionId, lifecycle, theme, density } from "./platform/values";
export default defineSchema({
  workspaces: defineTable({
    ownerId: v.id("platformUsers"),
    title: v.string(),
    theme,
    revision: v.number(),
  }).index("by_owner", ["ownerId"]),
  appInstances: defineTable({
    workspaceId: v.id("workspaces"),
    definitionId,
    title: v.string(),
    lifecycle,
    revision: v.number(),
    preferencesVersion: v.number(),
    sortOrder: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_lifecycle", ["workspaceId", "lifecycle"]),
  instancePreferences: defineTable({
    workspaceId: v.id("workspaces"),
    instanceId: v.id("appInstances"),
    density,
    revision: v.number(),
  }).index("by_instance", ["instanceId"]),
  operationReceipts: defineTable({
    ownerId: v.id("platformUsers"),
    workspaceId: v.id("workspaces"),
    operation: v.union(
      v.literal("notes.instance.create"),
      v.literal("recipes.instance.create"),
    ),
    key: v.string(),
    fingerprint: v.string(),
    instanceId: v.id("appInstances"),
  }).index("by_scope_key", ["ownerId", "workspaceId", "operation", "key"]),

  platformUsers: defineTable({
    provider: v.literal("better-auth"),
    subject: v.string(),
  }).index("by_provider_subject", ["provider", "subject"]),
});
