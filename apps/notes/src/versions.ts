import type { FunctionReturnType } from "convex/server";
import type { api } from "@palladian/notes-backend/api";

/**
 * Rules for the History panel (plan 08, A4) that do not need the page: what a
 * version is called, what it is compared with, and when a restore may run.
 *
 * A version is a stretch of the server's revision log: one person's edits
 * close together, a restore, or the note's creation. It goes from
 * `baseRevision` (the note before it) to `revision` (the note after it).
 */
export type Version = FunctionReturnType<
  typeof api.history.list
>["versions"][number];

export const kindLabels: Record<Version["kind"], string> = {
  create: "Created",
  edit: "Edited",
  restore: "Restored a version",
};

/**
 * A stable key for a version while it grows: the newest version's `revision`
 * and `endedAt` move as its author keeps typing, but where it starts does not.
 * Only creation and the first edit after it share a starting revision.
 */
export function versionKey(version: Pick<Version, "kind" | "baseRevision">) {
  return version.kind === "create" ? "create" : `from-${version.baseRevision}`;
}

/** What "vs Previous" compares with: the note before this version, if any. */
export function previousRevision(
  version: Pick<Version, "kind" | "baseRevision">,
): number | null {
  return version.kind === "create" ? null : version.baseRevision;
}

/**
 * Only an earlier state can be restored: the server refuses to restore the
 * note's current revision onto itself.
 */
export function canRestore(
  version: Pick<Version, "revision">,
  currentRevision: number | undefined,
): boolean {
  return currentRevision !== undefined && version.revision < currentRevision;
}

export interface RestoreRequest {
  revision: number;
  expectedRevision: number;
  requestId: string;
}

/**
 * Restore requests, so a retry is never applied twice. A retry after an
 * unanswered or failed request repeats it exactly, with the same request ID;
 * the server returns the first result if that one was applied. Once the server
 * answers (restored, conflict or refusal), the next restore is a new request.
 */
export class RestoreRequests {
  private pending: RestoreRequest | null = null;
  constructor(private readonly newId: () => string) {}

  /** The request to send for restoring `revision` onto `currentRevision`. */
  next(revision: number, currentRevision: number): RestoreRequest {
    if (this.pending?.revision !== revision)
      this.pending = {
        revision,
        expectedRevision: currentRevision,
        requestId: this.newId(),
      };
    return this.pending;
  }

  /** The server answered `request`; retries start over. */
  settled(request: RestoreRequest) {
    if (this.pending === request) this.pending = null;
  }
}
