import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { definitionId, lifecycle, theme, density } from "./platform/values";
import { fileState, resourceTarget } from "./platform/fileValues";
export default defineSchema({
  noteFixtures: defineTable({ workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), title: v.string(), text: v.string(), revision: v.number(), trashed: v.boolean() }).index("by_instance", ["instanceId"]),
  recipeFixtures: defineTable({ workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), title: v.string(), text: v.string(), revision: v.number(), trashed: v.boolean() }).index("by_instance", ["instanceId"]),
  searchEntries: defineTable({ workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), target: resourceTarget, title: v.string(), text: v.string(), sourceRevision: v.number(), projectedAt: v.number() }).index("by_resource", ["target.resourceId"]).searchIndex("search_text", { searchField: "text", filterFields: ["workspaceId", "instanceId"] }),
  files: defineTable({ workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), name: v.string(), type: v.string(), size: v.number(), sha256: v.string(), state: fileState, generation: v.number(), stagingObjectId: v.optional(v.id("fileObjects")), candidateObjectId: v.optional(v.id("fileObjects")), readyObjectId: v.optional(v.id("fileObjects")), leaseUntil: v.number(), maxUploadGrantExpiresAt: v.number(), failure: v.union(v.literal("TEMPORARY"), v.literal("VALIDATION"), v.null()), updatedAt: v.number(), receiptKey: v.string(), fingerprint: v.string() }).index("by_instance_state", ["instanceId", "state"]).index("by_receipt", ["workspaceId", "instanceId", "receiptKey"]).index("by_state_time", ["state", "updatedAt"]),
  fileObjects: defineTable({ fileId: v.id("files"), key: v.string(), role: v.union(v.literal("staging"), v.literal("candidate"), v.literal("ready")), generation: v.number(), cleanup: v.union(v.literal("retained"), v.literal("queued")), checkAfter: v.number(), deletedOnce: v.boolean(), failures: v.number() }).index("by_file", ["fileId"]).index("by_cleanup_time", ["cleanup", "checkAfter"]),
  fileReferences: defineTable({ workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), fileId: v.id("files"), target: resourceTarget }).index("by_file", ["fileId"]).index("by_resource", ["target.resourceId"]).index("by_pair", ["fileId", "target.resourceId"]),
  fileUsage: defineTable({ workspaceId: v.id("workspaces"), reservedBytes: v.number(), pendingCount: v.number() }).index("by_workspace", ["workspaceId"]),
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
