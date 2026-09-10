import type { Presentation, ResourceTarget } from "./index";
/** Pure canonical link construction; only the live backend resolver grants access. */
export function instanceHref(
  workspaceId: string,
  instanceId: string,
  presentation: Presentation,
): string {
  const instance = encodeURIComponent(instanceId);
  return presentation === "integrated"
    ? `/w/${encodeURIComponent(workspaceId)}/a/${instance}/`
    : `/a/${instance}/`;
}
export function resourceHref(
  workspaceId: string,
  target: ResourceTarget,
  presentation: Presentation,
): string {
  return `${instanceHref(workspaceId, target.instanceId, presentation)}r/${encodeURIComponent(target.resourceType)}/${encodeURIComponent(target.resourceId)}`;
}
