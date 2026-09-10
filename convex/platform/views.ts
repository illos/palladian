import type { Doc } from "../_generated/dataModel";
export function workspaceView(workspace: Doc<"workspaces">) {
  return {
    id: workspace._id,
    title: workspace.title,
    revision: workspace.revision,
    theme: workspace.theme,
  };
}
export function instanceView(instance: Doc<"appInstances">) {
  return {
    id: instance._id,
    workspaceId: instance.workspaceId,
    definitionId: instance.definitionId,
    title: instance.title,
    lifecycle: instance.lifecycle,
    revision: instance.revision,
    preferencesVersion: instance.preferencesVersion,
    sortOrder: instance.sortOrder,
    createdAt: instance._creationTime,
    updatedAt: instance.updatedAt,
  };
}
export function preferencesView(preferences: Doc<"instancePreferences">) {
  return {
    id: preferences._id,
    workspaceId: preferences.workspaceId,
    instanceId: preferences.instanceId,
    density: preferences.density,
    revision: preferences.revision,
  };
}
