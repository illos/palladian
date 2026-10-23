import { api } from "@palladian/notes-backend/api";
import type { ConvexReactClient } from "convex/react";

/**
 * Follow whether this server lets owners delete notebooks
 * (`notebooks.capabilities`, NOTEBOOK_DELETE_ENABLED; shipped off). Calls
 * `changed` with each answer; anything but a definite yes, including an error
 * or no answer yet, is off. Stopping reports off.
 */
export function watchNotebookCapability(
  client: ConvexReactClient,
  changed: (deleteEnabled: boolean) => void,
): () => void {
  const watch = client.watchQuery(api.notebooks.capabilities, {});
  const read = () => {
    let value: { delete: boolean } | undefined;
    try {
      value = watch.localQueryResult();
    } catch {
      value = undefined;
    }
    changed(value?.delete === true);
  };
  const stop = watch.onUpdate(read);
  read();
  return () => {
    stop();
    changed(false);
  };
}
