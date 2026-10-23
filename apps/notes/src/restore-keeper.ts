import type { RecordStore, CorruptEntry } from "./restore-store";
import type { RestoreOutcome } from "./versions";

/**
 * Restores this browser has sent (review rounds 3 and 4). A restore replaces
 * the whole note, so typing made while one is unresolved would be rebased
 * away when the replacement arrives. Each restore is therefore recorded
 * durably before it is sent (`restore-store.ts`), and while its record exists
 * the note is held read-only in every window of this browser.
 *
 * A record is pending until the server's answer says what happened. On
 * success it becomes applied, with the revision the restore produced, and
 * stays for APPLIED_HOLD_MS: each window keeps its editor of the note held
 * until that editor has received that revision, so no window types onto text
 * the replacement has yet to reach. A refusal removes it. Without an answer it
 * stays pending, and is reconciled by sending exactly the same request again:
 * `history.restore` answers a repeated request ID from its receipt instead of
 * applying it twice.
 *
 * Records hold IDs and revisions only, never note text (a minimal safety
 * record; see the implementation report on D28). They belong to one account
 * and are only ever sent, or replayed, while that account is signed in.
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
  /** Once the server has applied it: the revision it produced, and when. */
  appliedRevision?: number;
  appliedAt?: number;
}

/** At most this many records; more restores are refused, none evicted. */
export const RESTORE_RECORD_LIMIT = 20;
/** How long an applied restore keeps editors held until they receive it. */
export const APPLIED_HOLD_MS = 10 * 60_000;

/** Sends one restore request; resolves with its outcome. */
export type SendRestore = (record: PendingRestore) => Promise<RestoreOutcome>;

export interface KeeperState {
  /** "unavailable": this browser cannot record restores, so none may start. */
  status: "loading" | "ready" | "unavailable";
  records: readonly PendingRestore[];
  corrupt: readonly CorruptEntry[];
  /** Requests this window is waiting on, by request ID: when each was sent. */
  inFlight: ReadonlyMap<string, number>;
}

/** Why a note's editor is held, if it is. */
export type NoteHold =
  | { reason: "loading" }
  | { reason: "unreadable" }
  | { reason: "sending" | "unconfirmed" | "arriving"; record: PendingRestore };

/**
 * Whether this window must hold the editor of `noteId` read-only, given the
 * revision its editor has incorporated (null if it has no live editor).
 */
export function noteHold(
  state: KeeperState,
  accountId: string,
  noteId: string,
  editorRevision: number | null,
  now: number,
): NoteHold | null {
  if (state.status === "loading") return { reason: "loading" };
  // Unreadable records could hold any note of their account (or of anyone's,
  // if not even the account can be read).
  if (
    state.corrupt.some(
      (entry) => entry.accountId === null || entry.accountId === accountId,
    )
  )
    return { reason: "unreadable" };
  for (const record of state.records) {
    if (record.accountId !== accountId || record.noteId !== noteId) continue;
    if (record.appliedRevision === undefined)
      return {
        reason: state.inFlight.has(record.requestId)
          ? "sending"
          : "unconfirmed",
        record,
      };
    if (
      now - (record.appliedAt ?? 0) < APPLIED_HOLD_MS &&
      (editorRevision === null || editorRevision < record.appliedRevision)
    )
      return { reason: "arriving", record };
  }
  return null;
}

/** The unresolved (not yet applied) restore of a note, if there is one. */
export function pendingRestore(
  state: KeeperState,
  accountId: string,
  noteId: string,
): PendingRestore | undefined {
  return state.records.find(
    (record) =>
      record.accountId === accountId &&
      record.noteId === noteId &&
      record.appliedRevision === undefined,
  );
}

export class RestoreKeeper {
  private state: KeeperState = {
    status: "loading",
    records: [],
    corrupt: [],
    inFlight: new Map(),
  };
  private readonly listeners = new Set<() => void>();
  /** Requests in flight in this window, so one is never sent twice at once. */
  private readonly running = new Map<string, Promise<RestoreOutcome>>();
  private readonly sentAt = new Map<string, number>();
  private reading = 0;

  /**
   * `notify` tells this browser's other windows to reload (a
   * BroadcastChannel in the app); `store` is null if this browser cannot
   * record restores.
   */
  constructor(
    private readonly store: RecordStore | null,
    private readonly send: SendRestore,
    private readonly notify: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Reads the records from storage. In-memory state only ever comes from a
   * successful read, so a failed write cannot erase another record here.
   */
  async reload(): Promise<void> {
    if (!this.store) return this.set({ status: "unavailable" });
    const read = ++this.reading;
    try {
      const { records, corrupt } = await this.store.list();
      if (read === this.reading)
        this.set({ status: "ready", records, corrupt });
    } catch {
      if (read === this.reading && this.state.status === "loading")
        this.set({ status: "unavailable" });
    }
  }

  /**
   * Records a new restore durably, then sends it. Refuses without sending if
   * the record cannot be written and read back, or the store is full.
   */
  async restore(record: PendingRestore): Promise<RestoreOutcome> {
    if (!this.store || this.state.status !== "ready")
      return { kind: "not-recorded", reason: "unavailable" };
    let added: "added" | "full";
    try {
      added = await this.store.add(record, RESTORE_RECORD_LIMIT);
    } catch {
      await this.reload();
      return { kind: "not-recorded", reason: "failed" };
    }
    if (added === "full") return { kind: "not-recorded", reason: "full" };
    await this.reload();
    this.notify();
    return this.run(record);
  }

  /**
   * Sends an unresolved restore again, unchanged, to learn its outcome. A
   * request already in flight here is not sent twice; its outcome is shared.
   */
  check(record: PendingRestore): Promise<RestoreOutcome> {
    return this.run(record);
  }

  /** Removes applied records whose hold has run out. */
  async expire(): Promise<void> {
    if (!this.store) return;
    const old = this.state.records.filter(
      (record) =>
        record.appliedAt !== undefined &&
        this.now() - record.appliedAt >= APPLIED_HOLD_MS,
    );
    if (!old.length) return;
    try {
      await this.store.remove(old.map((record) => record.requestId));
      this.notify();
    } finally {
      await this.reload();
    }
  }

  /** Removes unreadable entries, after the person confirmed it. */
  async discardUnreadable(): Promise<void> {
    if (!this.store || !this.state.corrupt.length) return;
    try {
      await this.store.remove(this.state.corrupt.map((entry) => entry.key));
      this.notify();
    } finally {
      await this.reload();
    }
  }

  private run(record: PendingRestore): Promise<RestoreOutcome> {
    const running = this.running.get(record.requestId);
    if (running) return running;
    this.sentAt.set(record.requestId, this.now());
    // Registered before the request starts, so it is in flight from now on.
    const promise = Promise.resolve()
      .then(() => this.send(record))
      .catch((): RestoreOutcome => ({ kind: "unanswered" }))
      .then(async (outcome) => {
        try {
          await this.settle(record, outcome);
        } catch {
          // Storage refused the change: the record stays as it was, and is
          // reconciled again later.
        }
        this.running.delete(record.requestId);
        this.sentAt.delete(record.requestId);
        await this.reload();
        return outcome;
      });
    this.running.set(record.requestId, promise);
    this.publish();
    return promise;
  }

  private async settle(record: PendingRestore, outcome: RestoreOutcome) {
    if (!this.store) return;
    if (outcome.kind === "restored") {
      await this.store.markApplied(
        record.requestId,
        outcome.revision,
        this.now(),
      );
      this.notify();
    } else if (outcome.kind === "conflict" || outcome.kind === "refused") {
      await this.store.remove([record.requestId]);
      this.notify();
    }
  }

  private set(change: Partial<Omit<KeeperState, "inFlight">>) {
    this.state = { ...this.state, ...change };
    this.publish();
  }

  private publish() {
    this.state = {
      ...this.state,
      inFlight: new Map(
        [...this.running.keys()].map((id) => [
          id,
          this.sentAt.get(id) ?? this.now(),
        ]),
      ),
    };
    for (const listener of this.listeners) listener();
  }
}

/**
 * Sends a recorded restore only for the account it was recorded in and only
 * within one session (review round 4, R4-3): checked before loading the
 * sender, again right before the request goes out, and when its answer
 * arrives. An answer that arrives under another session says nothing about
 * this account's restore, so it counts as unanswered: the record stays and is
 * checked again when that account is signed in. (The request also names its
 * account, which the server checks.)
 */
export async function sendInSession(
  record: PendingRestore,
  session: {
    /** The account signed in now. */
    account: () => string | null;
    /** Captures the session now; the result says whether it still holds. */
    ticket: () => () => boolean;
  },
  load: () => Promise<SendRestore | null>,
): Promise<RestoreOutcome> {
  const unanswered: RestoreOutcome = { kind: "unanswered" };
  const ticket = session.ticket();
  const ours = () => session.account() === record.accountId && ticket();
  if (!ours()) return unanswered;
  const send = await load();
  if (!send || !ours()) return unanswered;
  const outcome = await send(record);
  return ours() ? outcome : unanswered;
}
