import { copyInSession, serverAnswered } from "./in-session";

/**
 * Restore-as-new-note operations, kept in App so they outlive the History
 * panel that started them: an account restoring one version of one note.
 *
 * Creation keys (History review round 6, R6-2), one per operation. A retry of
 * an operation that has not been answered, whether History was closed and
 * reopened or the request failed without an answer, sends the same key, and
 * `notes.create` returns the copy already made for it rather than making a
 * second. Once the server answers (made, or refused) the key is forgotten: a
 * deliberate second restore of the version makes another copy.
 *
 * Failures (review round 8, R8-1). Why the last restore of a version made no
 * note goes to the History panel showing that version, whichever panel that
 * is by then, as its notice until dismissed or retried; with no panel
 * showing the version, App shows a toast instead.
 *
 * Boundaries (review rounds 7 and 8, R7-3 and R8-2):
 * - In memory only. A full reload loses the keys, so a restore whose answer
 *   was lost before the reload, and then retried, can make a second note.
 * - An operation is "sending" until the Convex client answers it. The live
 *   layer and its client are created once per page (`main.tsx`) and never
 *   replaced or closed, but that does not guarantee an answer: the client
 *   can stop its connection after the server rejects its authentication
 *   while it fetches a new token, and signing out or in again
 *   (`clearAuth`, `setAuth`) does not restart it. The app then shows the
 *   server as unreachable and History is not offered. The operation stays
 *   "Creating…", and cannot be tried again, until the connection recovers or
 *   the page reloads; a reload loses its key. That connection recovery
 *   belongs to the fundamentals (`live.ts`), not to History.
 */
export type CopyState = "sending" | "unconfirmed" | null;

export class CopyKeys {
  private readonly copies = new Map<
    string,
    { key: string; sending: boolean }
  >();
  private readonly notices = new Map<string, string>();
  private readonly shown = new Map<string, number>();

  constructor(
    private readonly newKey: () => string = () =>
      "restore-" + crypto.randomUUID(),
  ) {}

  private id(account: string, noteId: string, revision: number) {
    return `${account}:${noteId}:${revision}`;
  }

  /** On its way, sent without an answer, or neither. */
  state(account: string, noteId: string, revision: number): CopyState {
    const copy = this.copies.get(this.id(account, noteId, revision));
    return copy ? (copy.sending ? "sending" : "unconfirmed") : null;
  }

  /**
   * The key to send now, or null if this copy is already on its way. Trying
   * again clears the last failure's notice.
   */
  start(account: string, noteId: string, revision: number): string | null {
    const id = this.id(account, noteId, revision);
    const copy = this.copies.get(id) ?? { key: this.newKey(), sending: false };
    if (copy.sending) return null;
    copy.sending = true;
    this.copies.set(id, copy);
    this.notices.delete(id);
    return copy.key;
  }

  /** The server answered: the copy exists, or was refused. */
  answered(account: string, noteId: string, revision: number) {
    this.copies.delete(this.id(account, noteId, revision));
  }

  /** No answer (or not sent): keep the key for the retry. */
  unanswered(account: string, noteId: string, revision: number) {
    const copy = this.copies.get(this.id(account, noteId, revision));
    if (copy) copy.sending = false;
  }

  /** A History panel shows this version until the returned call. */
  show(account: string, noteId: string, revision: number): () => void {
    const id = this.id(account, noteId, revision);
    this.shown.set(id, (this.shown.get(id) ?? 0) + 1);
    let shown = true;
    return () => {
      if (!shown) return;
      shown = false;
      const count = (this.shown.get(id) ?? 1) - 1;
      if (count > 0) this.shown.set(id, count);
      else this.shown.delete(id);
    };
  }

  /**
   * Why the last restore of this version made no note. A History panel
   * showing the version gets it as its notice; with none showing it,
   * `otherwise` gets it (App's toast) and nothing is kept.
   */
  failed(
    account: string,
    noteId: string,
    revision: number,
    message: string,
    otherwise: (message: string) => void,
  ) {
    const id = this.id(account, noteId, revision);
    if (this.shown.has(id)) this.notices.set(id, message);
    else otherwise(message);
  }

  /** The notice for a panel showing this version, until dismissed. */
  notice(account: string, noteId: string, revision: number): string | null {
    return this.notices.get(this.id(account, noteId, revision)) ?? null;
  }

  dismiss(account: string, noteId: string, revision: number) {
    this.notices.delete(this.id(account, noteId, revision));
  }
}

/**
 * A note's Restore-as-new-note operations, as App gives them to its History
 * panel (History review rounds 6 and 8).
 */
export interface VersionCopies {
  /** On its way, sent without an answer, or neither. */
  state: (revision: number) => CopyState;
  /** Why the last restore of the version made no note, until dismissed. */
  notice: (revision: number) => string | null;
  dismiss: (revision: number) => void;
  /** The panel shows the version until the returned call. */
  show: (revision: number) => () => void;
  /**
   * Creates a new note from the version's stored document. On success App
   * closes History; a failure comes back as the notice of whichever panel
   * shows the version by then, worded by `describe`, or as a toast.
   */
  restore: (
    doc: string,
    revision: number,
    describe: (failure: unknown) => string,
  ) => Promise<void>;
}

/** One Restore as a new note, as App runs it. */
export interface RestoreCopy<P> {
  keys: CopyKeys;
  account: string;
  noteId: string;
  revision: number;
  /** App's session ticket, taken when the restore started. */
  current: () => boolean;
  /** Signed in and connected when the restore started. */
  connected: boolean;
  /** Loads what the write needs; null sends nothing. */
  prepare: () => Promise<P | null>;
  /** Sends `notes.create` with this operation's key; the new note's ID. */
  dispatch: (prepared: P, key: string) => Promise<string>;
  /** Opens the new note. */
  open: (noteId: string) => void;
  /** The copy was made: close History and offer Open. */
  made: (noteId: string, open: () => void) => void;
  /** A failure in words (the History panel's wording, files off included). */
  describe: (failure: unknown) => string;
  /** Shows a message when no History panel shows the version. */
  toast: (message: string) => void;
  /** The operations changed: App renders again. */
  changed: () => void;
}

/**
 * Restore as a new note: one key per operation until answered (R6-2), made
 * and shown only in the session it started in (`copyInSession`, R6-1, R7-1,
 * R7-2), and its failure delivered at App scope (R8-1): to the History panel
 * showing the version by then, or else a toast. `copyInSession` calls the
 * failure only after checking the session synchronously, so the toast is
 * fenced too.
 */
export async function restoreCopy<P>(copy: RestoreCopy<P>): Promise<void> {
  const { keys, account, noteId, revision } = copy;
  const failed = (failure: unknown) => {
    keys.failed(account, noteId, revision, copy.describe(failure), copy.toast);
    copy.changed();
  };
  // A restore started in a session that has ended shows nothing (R9-1);
  // only the current session is told it is offline.
  if (!copy.current()) return;
  if (!copy.connected) return failed(new Error("Not connected."));
  const key = keys.start(account, noteId, revision);
  if (!key) return;
  copy.changed();
  const outcome = await copyInSession(
    copy.current,
    copy.prepare,
    (prepared) => copy.dispatch(prepared, key),
    copy.open,
    { made: copy.made, failed },
  );
  // Once the server has answered (made, or refused, which makes nothing) a
  // later restore may use a new key; otherwise the key stays for the retry.
  if (serverAnswered(outcome)) keys.answered(account, noteId, revision);
  else keys.unanswered(account, noteId, revision);
  copy.changed();
}
