import type { NoteRole } from "./cache";
import { isLocalNoteId } from "./note-actions";

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
 * this person's notes: one that is read-only now, or one gone from this
 * device's list, unless there is evidence the person deleted it themselves
 * (the server files the owner's draft for a notebook they deleted in their
 * default notebook). The evidence is the role this tab last saw for this
 * account (`lastRole`) or the server's answer for this account
 * (`deletedByMe`); without either, ownership is unknown and the draft counts
 * as lost (review rounds 2 to 4; D86). The app neither opens, shows nor
 * searches such a draft.
 *
 * A conflict copy (`source` set) is not decided here: it is authorized
 * through its source note, which the cache's source-access fencing already
 * holds or revokes (review round 4, R4-2).
 */
export function draftNotebookLost(
  draft: {
    id: string;
    notebookId?: string | undefined;
    source?: string | undefined;
  },
  notebooks: readonly { id: string; role: NoteRole }[],
  lastRole: (notebookId: string) => NoteRole | undefined,
  deletedByMe: (notebookId: string) => boolean,
): boolean {
  if (!isLocalNoteId(draft.id) || !draft.notebookId || draft.source)
    return false;
  const listed = notebooks.find((notebook) => notebook.id === draft.notebookId);
  if (listed) return listed.role === "read";
  return (
    lastRole(draft.notebookId) !== "owner" && !deletedByMe(draft.notebookId)
  );
}

/** One key per account and item, so nothing is shared across accounts. */
function scoped(accountId: string, id: string) {
  return JSON.stringify([accountId, id]);
}

/**
 * The role each notebook had when this device last listed it, per account
 * (review round 4, R4-1): what one account saw never counts as evidence for
 * another account signed in later in the same window.
 */
export class NotebookEvidence {
  private readonly roles = new Map<string, NoteRole>();
  remember(
    notebooks: readonly { accountId: string; id: string; role: NoteRole }[],
  ) {
    for (const notebook of notebooks)
      this.roles.set(scoped(notebook.accountId, notebook.id), notebook.role);
  }
  role(accountId: string, notebookId: string): NoteRole | undefined {
    return this.roles.get(scoped(accountId, notebookId));
  }
}

/**
 * The notebook each draft started in this window is for, per account
 * (review rounds 2 and 4). `undefined` means "the default notebook".
 */
export class DraftTargets {
  private readonly targets = new Map<string, string | undefined>();
  set(accountId: string, draftId: string, notebookId: string | undefined) {
    this.targets.set(scoped(accountId, draftId), notebookId);
  }
  has(accountId: string, draftId: string) {
    return this.targets.has(scoped(accountId, draftId));
  }
  get(accountId: string, draftId: string) {
    return this.targets.get(scoped(accountId, draftId));
  }
}
