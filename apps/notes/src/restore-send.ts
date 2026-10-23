import type { ConvexReactClient } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import { transportError } from "./live";
import type { PendingRestore } from "./restore-keeper";
import type { RestoreOutcome } from "./versions";

/**
 * Sends one restore request, loaded on first use so the notes list does not
 * wait for the backend API. A first restore and a reconciliation send exactly
 * the same request. It names the account it was recorded in: the server
 * refuses it under any other sign-in (review round 4, R4-3).
 */
export async function sendRestore(
  client: ConvexReactClient,
  record: PendingRestore,
): Promise<RestoreOutcome> {
  try {
    const result = await client.mutation(api.history.restore, {
      noteId: record.noteId as Id<"notes">,
      revision: record.revision,
      expectedRevision: record.expectedRevision,
      requestId: record.requestId,
      account: record.accountId,
    });
    return { kind: "restored", revision: result.revision };
  } catch (failure) {
    const error = transportError(failure);
    // No answer, or no answer that says what happened: ask again later.
    if (error.code === "transient") return { kind: "unanswered" };
    if (error.code === "conflict") return { kind: "conflict" };
    return { kind: "refused", message: error.message };
  }
}
