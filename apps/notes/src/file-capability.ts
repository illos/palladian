import { api } from "@palladian/notes-backend/api";
import type { ConvexReactClient } from "convex/react";

/**
 * Whether the server accepts file features (file blocks, image widths,
 * images showing uploaded objects) in new content yet: FILES_WRITES_ENABLED,
 * review round 4. Off until the server says on. While off, the editor keeps
 * them out of pasted content (editor-clipboard.ts `safeSlice`), because the
 * server would refuse the edit and stop the note from saving.
 */
let writes = false;

export function fileWritesEnabled(): boolean {
  return writes;
}

/** For tests, and for the watcher below. */
export function setFileWrites(value: boolean) {
  writes = value;
}

/** Follow `files.capabilities` for the signed-in account; stop turns files off. */
export function watchFileCapability(client: ConvexReactClient): () => void {
  const watch = client.watchQuery(api.files.capabilities, {});
  const read = () => {
    let value: { writes: boolean } | undefined;
    try {
      value = watch.localQueryResult();
    } catch {
      value = undefined;
    }
    writes = value?.writes === true;
  };
  const stop = watch.onUpdate(read);
  read();
  return () => {
    stop();
    writes = false;
  };
}
