import type { NoteRole } from "./cache";

/**
 * What can be done to a note, and where each action appears: the long-press
 * sheet, the desktop row menu, the open note's menu, and swipes. One set of
 * rules for all of them, by the note's role and lifecycle (plan 08, A2).
 */

export type ActionId =
  | "pin"
  | "unpin"
  | "duplicate"
  | "move"
  | "share"
  | "history"
  | "info"
  | "export"
  | "print"
  | "trash"
  | "restore"
  | "delete";

export interface ActionTarget {
  id: string;
  /** Local drafts and conflict copies not yet on the server have no actions. */
  local: boolean;
  role: NoteRole | null | undefined;
  trashed: boolean;
  /** Pinned by this person (pins are personal, D102). */
  pinned?: boolean;
}

export const actionLabels: Record<ActionId, string> = {
  pin: "Pin",
  unpin: "Unpin",
  duplicate: "Duplicate",
  move: "Move…",
  share: "Share…",
  history: "History",
  info: "Info",
  export: "Export as Markdown",
  print: "Print or save as PDF",
  trash: "Move to Trash",
  restore: "Restore",
  delete: "Delete forever…",
};

/** Actions that change data stay hidden until the server is reachable. */
const needsServer: Record<ActionId, boolean> = {
  pin: true,
  unpin: true,
  duplicate: true,
  move: true,
  share: true,
  history: true,
  info: true,
  export: false,
  print: false,
  trash: true,
  restore: true,
  delete: true,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A note written on this device and not yet created on the server ("local-"
 * IDs, and bare UUIDs from earlier offline creation, as the cache treats
 * them). A server note with unsent edits keeps its server ID.
 */
export function isLocalNoteId(id: string) {
  return id.startsWith("local-") || UUID.test(id);
}

/** The actions a note offers, in menu order. */
export function noteActions(target: ActionTarget, online: boolean): ActionId[] {
  if (target.local) return [];
  const edit = target.role === "owner" || target.role === "edit";
  const owner = target.role === "owner";
  const all: ActionId[] = target.trashed
    ? [
        ...(edit ? (["restore"] as const) : []),
        "info",
        "export",
        "print",
        ...(owner ? (["delete"] as const) : []),
      ]
    : [
        target.pinned ? "unpin" : "pin",
        "duplicate",
        ...(owner ? (["move"] as const) : []),
        "share",
        // Past versions are for editors only (D13), and come from the server.
        ...(edit ? (["history"] as const) : []),
        "info",
        "export",
        "print",
        ...(edit ? (["trash"] as const) : []),
      ];
  return all.filter((id) => online || !needsServer[id]);
}

export interface SwipeLayout {
  /** Revealed by swiping right; the row rests open on them. */
  leading: ActionId[];
  /** Revealed by swiping left. */
  trailing: ActionId[];
  /** Run by swiping left past the full-swipe distance, if any. */
  full: ActionId | null;
  /** Run by swiping right past the full-swipe distance, if any. */
  fullLeading: ActionId | null;
}

/**
 * Swipes: right rests on Duplicate (Restore in Trash) and a full right swipe
 * pins or unpins; left rests on Move and Share, and a full left swipe moves the
 * note to Trash (Undo follows). In Trash, left rests on Delete forever, which
 * still asks first.
 */
export function swipeLayout(
  target: ActionTarget,
  online: boolean,
): SwipeLayout {
  const available = new Set(noteActions(target, online));
  const pick = (ids: ActionId[]) => ids.filter((id) => available.has(id));
  if (target.trashed)
    return {
      leading: pick(["restore"]),
      trailing: pick(["delete"]),
      full: null,
      fullLeading: null,
    };
  return {
    leading: pick(["duplicate"]),
    trailing: pick(["move", "share"]),
    full: available.has("trash") ? "trash" : null,
    fullLeading: available.has("unpin")
      ? "unpin"
      : available.has("pin")
        ? "pin"
        : null,
  };
}
