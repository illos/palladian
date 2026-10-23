/**
 * Creation keys for "Restore as a new note" (History review round 6, R6-2),
 * one per copy operation: an account restoring one version of one note. A
 * retry of an operation that has not been answered, whether History was
 * closed and reopened or the request failed without an answer, sends the same
 * key, and `notes.create` returns the copy already made for it rather than
 * making a second. Once the server answers (made, or refused) the key is
 * forgotten: a deliberate second restore of the version makes another copy.
 * Kept in App, so it outlives the panel; in memory only.
 */
export type CopyState = "sending" | "unconfirmed" | null;

export class CopyKeys {
  private readonly copies = new Map<
    string,
    { key: string; sending: boolean }
  >();

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

  /** The key to send now, or null if this copy is already on its way. */
  start(account: string, noteId: string, revision: number): string | null {
    const id = this.id(account, noteId, revision);
    const copy = this.copies.get(id) ?? { key: this.newKey(), sending: false };
    if (copy.sending) return null;
    copy.sending = true;
    this.copies.set(id, copy);
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
}
