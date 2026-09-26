import { v } from "convex/values";
export const fileState = v.union(v.literal("pending"), v.literal("verifying"), v.literal("ready"), v.literal("deleting"), v.literal("deleted"));
export const resourceTarget = v.union(
  v.object({ definitionId: v.literal("notes"), resourceType: v.literal("note"), instanceId: v.id("appInstances"), resourceId: v.id("noteFixtures") }),
  v.object({ definitionId: v.literal("recipes"), resourceType: v.literal("recipe"), instanceId: v.id("appInstances"), resourceId: v.id("recipeFixtures") }),
);
export const fileScope = { workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), fileId: v.id("files") };
export const fileView = v.object({ id: v.id("files"), workspaceId: v.id("workspaces"), instanceId: v.id("appInstances"), name: v.string(), type: v.string(), size: v.number(), sha256: v.string(), state: fileState, failure: v.union(v.literal("TEMPORARY"), v.literal("VALIDATION"), v.null()) });
export const resourceView = v.object({ target: resourceTarget, workspaceId: v.id("workspaces"), title: v.string(), text: v.string(), revision: v.number(), source: v.literal("fixture"), instanceTitle: v.string(), href: v.string() });
export const filePolicy = Object.freeze({ bytes: 100 * 1024 * 1024, workspaceBytes: 1024 * 1024 * 1024, pending: 10, grantSeconds: 900, downloadSeconds: 300, leaseMs: 120000, orphanMs: 86400000, retryMs: 60000, maxAttempts: 20, maxReferences: 20, projectionCharacters: 16384 });
