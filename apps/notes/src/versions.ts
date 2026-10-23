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

/**
 * Why this window may not restore right now, if it may not. A restore
 * replaces the whole note; typing this window has not yet sent would be
 * rebased onto the replaced text and lost, so the restore waits until the
 * note's open editor here reports everything saved (nothing unsent, nothing
 * in flight, no failure) and this window knows of no unsent edits journaled
 * for it. It also needs the connection, to read the current revision it
 * expects to replace.
 *
 * This covers this window only. Another tab learns nothing from this one's
 * cache notifications, and other devices are out of reach: their unsent
 * typing is still replaced (a known gap in collaboration, outside History).
 */
export type RestoreHold = "offline" | "unsaved" | null;

export function restoreHold(state: {
  connected: boolean;
  /** The note as open in this window, if it is, with its editor's save status. */
  open: {
    kind: "cached" | "draft" | "live" | "reader";
    status: "offline" | "syncing" | "saving" | "saved" | "blocked" | null;
  } | null;
  /** Unsent edits to the note are journaled on this device. */
  journaled: boolean;
}): RestoreHold {
  if (!state.connected) return "offline";
  if (state.journaled) return "unsaved";
  // A local draft view of the note, or an editor not yet known to be saved.
  if (state.open?.kind === "draft") return "unsaved";
  if (state.open?.kind === "live" && state.open.status !== "saved")
    return "unsaved";
  return null;
}

/** How a restore request ended. */
export type RestoreOutcome =
  | { kind: "restored" }
  /** The note changed first; nothing was restored. */
  | { kind: "conflict" }
  /** The request failed without an answer; repeating it is safe. */
  | { kind: "unanswered" }
  | { kind: "refused"; message: string };

/** What a toast says about a restore that did not apply, once History is closed. */
export function restoreOutcomeText(
  outcome: Exclude<RestoreOutcome, { kind: "restored" }>,
): string {
  switch (outcome.kind) {
    case "conflict":
      return "The restore did not apply: the note changed first.";
    case "unanswered":
      return "The restore did not reach the server. Open History to try again.";
    case "refused":
      return `The restore did not apply: ${outcome.message}`;
  }
}

export interface VersionPageResult {
  versions: Version[];
  nextBefore: number | null;
}

/** The key for the page of versions before a revision (or the newest). */
export function pageKey(before: number | undefined) {
  return before === undefined ? "newest" : `before-${before}`;
}

/**
 * The list of versions across pages. Each page starts where the page above
 * it ends now. A page counts only once it has loaded for that cursor: a
 * result for an older cursor is not shown, because new versions at the top
 * push versions from one page into the next and the old result would skip
 * them. That page, and everything below it, shows as loading instead.
 */
export function pageChain(
  pages: number,
  results: Readonly<Record<string, VersionPageResult | undefined>>,
): {
  /** The pages to ask for, by cursor. */
  cursors: (number | undefined)[];
  versions: Version[];
  /** "loading": a page is on its way; "more": older versions exist. */
  end: "loading" | "more" | "done";
} {
  const cursors: (number | undefined)[] = [];
  const versions: Version[] = [];
  let before: number | undefined;
  for (let page = 0; page < pages; page++) {
    cursors.push(before);
    const result = results[pageKey(before)];
    if (!result) return { cursors, versions, end: "loading" };
    versions.push(...result.versions);
    if (result.nextBefore === null) return { cursors, versions, end: "done" };
    before = result.nextBefore;
  }
  return { cursors, versions, end: "more" };
}
