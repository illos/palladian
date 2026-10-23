import type { NoteRole } from "./cache";

/**
 * What can be done to a notebook from its menu (plan 08, A5): right-click or
 * the hover "…" on a sidebar notebook, a long press in the phone navigation,
 * and the "…" in a notebook's list header. One set of rules for all of them,
 * by the person's role and the connection.
 */

export type NotebookActionId =
  "new" | "rename" | "sharing" | "members" | "default" | "delete";

export interface NotebookTarget {
  id: string;
  name: string;
  role: NoteRole;
  isDefault: boolean;
}

export const notebookActionLabels: Record<NotebookActionId, string> = {
  new: "New note here",
  rename: "Name and description…",
  sharing: "Sharing and members…",
  members: "Members…",
  default: "Set as default",
  delete: "Delete notebook…",
};

/**
 * Only a new note works offline: it waits on this device as a draft. The
 * rest change or read server state.
 */
const needsServer: Record<NotebookActionId, boolean> = {
  new: false,
  rename: true,
  sharing: true,
  members: true,
  default: true,
  delete: true,
};

/**
 * The actions a notebook offers, in menu order. Owners rename, share, choose
 * it as their default and delete it; anyone who can edit adds notes; others
 * see who has access. Delete stays offered for the default notebook: its
 * dialog asks for another default first, as the server requires.
 */
export function notebookActions(
  target: NotebookTarget,
  online: boolean,
): NotebookActionId[] {
  const owner = target.role === "owner";
  const edit = owner || target.role === "edit";
  const all: NotebookActionId[] = [
    ...(edit ? (["new"] as const) : []),
    ...(owner ? (["rename", "sharing"] as const) : (["members"] as const)),
    ...(owner && !target.isDefault ? (["default"] as const) : []),
    ...(owner ? (["delete"] as const) : []),
  ];
  return all.filter((id) => online || !needsServer[id]);
}

/** Notes in each notebook as this device has them, Trash left out. */
export function notebookCounts(
  rows: readonly {
    notebookId?: string | undefined;
    trashed?: boolean | undefined;
  }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows)
    if (row.notebookId && !row.trashed)
      counts.set(row.notebookId, (counts.get(row.notebookId) ?? 0) + 1);
  return counts;
}

/**
 * The notebook a new note goes to: the one shown, while it is still on this
 * device and takes this person's notes. Otherwise none, and the caller uses
 * the default notebook (review round 1, F1): a notebook deleted or unshared
 * elsewhere must not receive new work.
 */
export function newNoteNotebook(
  shownId: string | null,
  notebooks: readonly { id: string; role: NoteRole }[],
): string | undefined {
  const shown = notebooks.find((notebook) => notebook.id === shownId);
  return shown && shown.role !== "read" ? shown.id : undefined;
}

/**
 * Whether the deletion preview answers the destination and choice now
 * selected; deleting waits for it (review round 1, F5).
 */
export function previewMatches(
  preview: { destinationId: string; trash: boolean } | null | undefined,
  destinationId: string,
  trash: boolean,
): boolean {
  return (
    !!preview &&
    preview.destinationId === destinationId &&
    preview.trash === trash
  );
}

/**
 * Whether an uncreated draft is aimed at a notebook that no longer takes
 * this person's notes: one gone from this device's list, unless it was their
 * own (the server files the owner's draft for a notebook they deleted in
 * their default notebook), or one that is read-only now. The app does not
 * open such a draft (review round 2, R2-1; D86). `lastRole` is the role the
 * notebook had when this device last listed it.
 */
export function draftNotebookLost(
  draft: { id: string; notebookId?: string | undefined },
  notebooks: readonly { id: string; role: NoteRole }[],
  lastRole: (notebookId: string) => NoteRole | undefined,
): boolean {
  if (!draft.id.startsWith("local-") || !draft.notebookId) return false;
  const listed = notebooks.find((notebook) => notebook.id === draft.notebookId);
  if (listed) return listed.role === "read";
  return lastRole(draft.notebookId) !== "owner";
}
