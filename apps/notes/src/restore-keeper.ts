import type { RestoreOutcome } from "./versions";

/**
 * Restores this browser has sent and not yet seen answered (review round 3,
 * R3-1). A restore replaces the whole note, so while one is unresolved its
 * note must not be edited anywhere in this browser: typing made meanwhile
 * would be rebased away when the replacement arrives. The record is written
 * before the request is sent and removed only once the outcome is known
 * (restored, refused because the note changed, or refused for another
 * reason). It survives closing History, opening other notes, reloading and
 * other windows of this browser, which read the same storage.
 *
 * An unresolved record is reconciled by sending the same request again, with
 * the same request ID and arguments. `history.restore` answers that from its
 * receipt if the first request was applied (the server returns its result
 * without applying it twice); otherwise it applies the restore now if the
 * note has not changed since, or refuses with a conflict. Either way the
 * outcome is known and the record goes.
 *
 * The records live in localStorage under an app-owned key, not in the notes
 * cache. They hold IDs and revisions only, never note text.
 */
export interface PendingRestore {
  accountId: string;
  noteId: string;
  /** The revision being restored. */
  revision: number;
  /** The note's revision the restore expects to replace. */
  expectedRevision: number;
  requestId: string;
  /** When the restored version ended, for saying which version it was. */
  versionEndedAt: number;
  /** When the restore was first sent. */
  since: number;
}

export const PENDING_RESTORES_KEY = "palladian.notes.pending-restores.v1";

/** The part of the Storage interface the keeper uses. */
export interface KeeperStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Sends one restore request; resolves with its outcome. */
export type SendRestore = (record: PendingRestore) => Promise<RestoreOutcome>;

export interface KeeperState {
  pending: readonly PendingRestore[];
  /** Requests this window is waiting on, by request ID: when each was sent. */
  inFlight: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is PendingRestore {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    typeof record.noteId === "string" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    Number.isSafeInteger(record.revision) &&
    Number.isSafeInteger(record.expectedRevision) &&
    typeof record.versionEndedAt === "number" &&
    typeof record.since === "number"
  );
}

export class RestoreKeeper {
  private state: KeeperState;
  private readonly listeners = new Set<() => void>();
  /** Requests in flight in this window, so one is never sent twice at once. */
  private readonly running = new Map<string, Promise<RestoreOutcome>>();
  /** What storage holds, or this window's copy when storage fails. */
  private memory: PendingRestore[] = [];

  constructor(
    private readonly storage: KeeperStorage | null,
    private readonly send: SendRestore,
    private readonly now: () => number = Date.now,
  ) {
    this.memory = this.read();
    this.state = { pending: this.memory, inFlight: new Map() };
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Another window changed the records (a `storage` event for the key). */
  reload() {
    this.memory = this.read();
    this.publish();
  }

  /** The unresolved restore of this note by this account, if there is one. */
  holding(accountId: string, noteId: string): PendingRestore | undefined {
    return this.state.pending.find(
      (record) => record.accountId === accountId && record.noteId === noteId,
    );
  }

  /** Records a new restore, then sends it. */
  restore(record: PendingRestore): Promise<RestoreOutcome> {
    this.change((list) => [
      ...list.filter((other) => other.requestId !== record.requestId),
      record,
    ]);
    return this.run(record);
  }

  /**
   * Sends an unresolved restore again, unchanged, to learn its outcome. A
   * request already in flight here is not sent twice; its outcome is shared.
   */
  check(record: PendingRestore): Promise<RestoreOutcome> {
    return this.run(record);
  }

  private run(record: PendingRestore): Promise<RestoreOutcome> {
    const running = this.running.get(record.requestId);
    if (running) return running;
    // Registered before the request starts, so it is in flight from now on.
    const promise = Promise.resolve()
      .then(() => this.send(record))
      .catch((): RestoreOutcome => ({ kind: "unanswered" }))
      .then((outcome) => {
        this.running.delete(record.requestId);
        if (outcome.kind === "unanswered") this.publish();
        else
          this.change((list) =>
            list.filter((other) => other.requestId !== record.requestId),
          );
        return outcome;
      });
    this.running.set(record.requestId, promise);
    this.publish();
    return promise;
  }

  private read(): PendingRestore[] {
    if (!this.storage) return this.memory;
    try {
      const value: unknown = JSON.parse(
        this.storage.getItem(PENDING_RESTORES_KEY) ?? "[]",
      );
      return Array.isArray(value) ? value.filter(isRecord) : [];
    } catch {
      return this.memory;
    }
  }

  /** Read, change and write the records, so other windows' records stay. */
  private change(update: (list: PendingRestore[]) => PendingRestore[]) {
    this.memory = update(this.read());
    try {
      this.storage?.setItem(PENDING_RESTORES_KEY, JSON.stringify(this.memory));
    } catch {
      // Storage refused: the hold still applies in this window.
    }
    this.publish();
  }

  private publish() {
    const inFlight = new Map<string, number>();
    for (const requestId of this.running.keys())
      inFlight.set(requestId, this.state.inFlight.get(requestId) ?? this.now());
    this.state = { pending: [...this.memory], inFlight };
    for (const listener of this.listeners) listener();
  }
}
