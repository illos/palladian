import type { FunctionReturnType } from "convex/server";
import {
  addsFileFeatures,
  fileFeatures,
} from "@palladian/notes-core/attachments";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { api } from "@palladian/notes-backend/api";

/**
 * Rules for the History panel (plan 08, A4) that do not need the page: what a
 * version is called, what it is compared with, and how its pages chain.
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

/**
 * Whether the server would refuse this version as a new note while file
 * writes are off (B1+B2): a copy may keep only the file blocks, attached
 * images and image sizes that the note it copies has now, and an old version
 * may hold others. No such content exists while files are off; this keeps the
 * message clear if it ever does.
 */
export function copyNeedsFiles(
  version: ProseMirrorNode,
  current: ProseMirrorNode | null,
  filesOn: boolean,
): boolean {
  return !filesOn && addsFileFeatures(version, fileFeatures(current));
}

export const COPY_NEEDS_FILES_MESSAGE =
  "This version has files or image sizes that the note no longer has. It can’t be restored as a new note until files are turned on.";

/** The server's refusal of file content while files are off (B1). */
export function isFilesOffRefusal(error: { code: string; message: string }) {
  return (
    error.code === "invalid" && /not enabled on this server/.test(error.message)
  );
}
