import type { ConvexReactClient } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import { transportError } from "./live";
import type { PendingRestore } from "./restore-keeper";
import type { RestoreOutcome } from "./versions";

/**
 * Sends one restore request (review round 3, R3-1), loaded on first use so
 * the notes list does not wait for the backend API. A first restore and a
 * reconciliation send exactly the same request.
 */
export async function sendRestore(
  client: ConvexReactClient,
  record: PendingRestore,
): Promise<RestoreOutcome> {
  try {
    await client.mutation(api.history.restore, {
      noteId: record.noteId as Id<"notes">,
      revision: record.revision,
      expectedRevision: record.expectedRevision,
      requestId: record.requestId,
    });
    return { kind: "restored" };
  } catch (failure) {
    const error = transportError(failure);
    // No answer, or no answer that says what happened: ask again later.
    if (error.code === "transient") return { kind: "unanswered" };
    if (error.code === "conflict") return { kind: "conflict" };
    return { kind: "refused", message: error.message };
  }
}
