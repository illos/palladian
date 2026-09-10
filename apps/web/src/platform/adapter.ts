import type { api } from "../../../../convex/_generated/api";
import type {
  AppInstance,
  InstanceId,
  WorkspaceId,
} from "../../../../packages/contracts/src/index";

/** Adapt a validated server view once at the host boundary. Brands carry no
 * authority; every later server operation must still check the live scope. */
export function appInstance(
  view: typeof api.platform.instances.get._returnType,
): AppInstance {
  return {
    id: view.id as string as InstanceId,
    workspaceId: view.workspaceId as string as WorkspaceId,
    definitionId: view.definitionId,
    title: view.title,
    lifecycle: view.lifecycle,
    preferencesVersion: view.preferencesVersion,
  };
}
