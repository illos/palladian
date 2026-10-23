import { api } from "@palladian/notes-backend/api";
import {
  fileFeatures,
  stepAddsFileFeatures,
} from "@palladian/notes-core/attachments";
import type { ConvexReactClient } from "convex/react";
import { isHistoryTransaction } from "prosemirror-history";
import { Plugin } from "prosemirror-state";

/**
 * Whether the server accepts file features (file blocks, image widths,
 * images showing uploaded objects) in new content yet: FILES_WRITES_ENABLED,
 * review round 4. Off until the server says on. While off, the editor keeps
 * those the note does not already have out of pasted and dropped content
 * (editor-clipboard.ts `safeSlice`) and out of undo and redo
 * (`fileHistoryGate`), because the server would refuse the edit and stop the
 * note from saving.
 */
let writes = false;
const listeners = new Set<() => void>();

export function fileWritesEnabled(): boolean {
  return writes;
}

/** For tests, and for the watcher below. */
export function setFileWrites(value: boolean) {
  if (writes === value) return;
  writes = value;
  for (const listener of listeners) listener();
}

/** Call `listener` whenever files are turned on or off (B3: "+ File", resizing). */
export function onFileWritesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
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
    setFileWrites(value?.writes === true);
  };
  const stop = watch.onUpdate(read);
  read();
  return () => {
    stop();
    setFileWrites(false);
  };
}

export const FILE_UNDO_MESSAGE =
  "Undo can't bring back removed files or image sizes yet.";

/**
 * While files are off, undo and redo do not bring back file features the
 * note no longer has (an attachment or image width removed earlier): the
 * server would refuse the step. Such an undo does nothing and `refused` is
 * called, so the editor can say why (review round 5). The note as it is now
 * is the measure, because a removal may reach the server before the undo.
 */
export function fileHistoryGate(refused?: () => void): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (writes || !isHistoryTransaction(tr)) return true;
      const existing = fileFeatures(state.doc);
      const allowed = tr.steps.every(
        (step, index) => !stepAddsFileFeatures(step, tr.docs[index]!, existing),
      );
      if (!allowed) refused?.();
      return allowed;
    },
  });
}
