import Dexie, { type Table } from "dexie";

export type NoteRole = "owner" | "edit" | "read";
export interface NoteSummary {
  accountId: string;
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  kind: "cached" | "draft";
  notebookId?: string;
  role?: NoteRole;
  trashed?: boolean;
  /** A conflict copy's source note, as on its draft. */
  source?: string;
}
/** Server-side summary fields delivered by the library feed. */
export interface RemoteSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  notebookId: string;
  role: NoteRole;
  trashed: boolean;
}
export interface NoteBody {
  accountId: string;
  id: string;
  document: string;
  text: string;
  revision?: number;
}
/**
 * Recovery journal entry. Local notes not yet on the server carry only their
 * current document. Live notes also carry the accepted base revision and the
 * unconfirmed editor steps made on top of it.
 */
export interface Draft extends NoteBody {
  updatedAt: number;
  baseDocument?: string;
  baseRevision?: number;
  steps?: string[];
  clientId?: string;
  /** False for a collaborative note whose server creation has not finished. */
  created?: boolean;
  notebookId?: string;
  /**
   * For a conflict copy not yet created: the note whose content it holds. It is
   * authorized as that note and removed with it.
   */
  source?: string;
}
export interface CachedNotebook {
  accountId: string;
  id: string;
  name: string;
  description: string;
  role: NoteRole;
  ownerName: string;
  isDefault: boolean;
}
export interface ActivationFence {
  epoch: number;
  localEpoch: number;
}
export interface CacheFence {
  accountId: string;
  epoch: number;
}
interface CacheEvent {
  accountId?: string;
  invalidated?: boolean;
  /** Notes this account lost access to; their content and pending work are gone. */
  revokedNotes?: string[];
  /** Notes hidden while the server confirms access; their pending work is kept. */
  heldNotes?: string[];
}

class NotesDatabase extends Dexie {
  summaries!: Table<NoteSummary, [string, string]>;
  bodies!: Table<NoteBody, [string, string]>;
  drafts!: Table<Draft, [string, string]>;
  accounts!: Table<
    // `lifecycle` advances when a cleared account is signed in again: a clear
    // is meant for one lifecycle.
    { accountId: string; epoch: number; blocked: boolean; lifecycle?: number },
    string
  >;
  privacy!: Table<{ key: string; epoch: number }, string>;
  notebooks!: Table<CachedNotebook, [string, string]>;
  cursors!: Table<
    { accountId: string; key: string; value: number },
    [string, string]
  >;
  revoked!: Table<
    // `nonce` changes with every revocation recorded for the note. A `held`
    // fence hides the note's local work until the server confirms access.
    {
      accountId: string;
      id: string;
      at: number;
      nonce?: string;
      held?: boolean;
    },
    [string, string]
  >;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      summaries: "[accountId+id], accountId",
      bodies: "[accountId+id], accountId",
      drafts: "[accountId+id], accountId",
      accounts: "accountId",
      privacy: "key",
    });
    this.version(2).stores({
      notebooks: "[accountId+id], accountId",
      cursors: "[accountId+key], accountId",
    });
    // Persistent note-level access fences: late responses and other tabs cannot
    // restore content for a note this account lost.
    this.version(3).stores({ revoked: "[accountId+id], accountId" });
    // Conflict-copy summaries carry their source, as the drafts already do.
    this.version(4).upgrade(async (tx) => {
      const drafts: Draft[] = await tx.table("drafts").toArray();
      for (const draft of drafts)
        if (draft.source)
          await tx
            .table("summaries")
            .update([draft.accountId, draft.id], { source: draft.source });
    });
  }
}

/** A clear retried after the account was signed in again. */
class SupersededClear extends Error {}
interface ClearOperation {
  accountId: string;
  /** The lifecycle this clear ends: known when decided, or first read. */
  lifecycle: number | undefined;
  /** Whether it cleared (false: superseded); null while unfinished. */
  result: boolean | null;
  attempts: number;
  running?: Promise<boolean> | undefined;
  retry?: ReturnType<typeof setTimeout>;
}

/** Unsaved snapshots by note key; `version` changes with every change. */
class SnapshotMap extends Map<string, Draft> {
  version = 0;
  override set(key: string, value: Draft) {
    this.version++;
    return super.set(key, value);
  }
  override delete(key: string) {
    this.version++;
    return super.delete(key);
  }
}

/** Display cache and recovery journal only; neither is server authority. */
export class NotesStore {
  private readonly db: NotesDatabase;
  private readonly epochs = new Map<string, number>();
  private activationEpoch = 0;
  private readonly blocked = new Set<string>();
  private readonly listeners = new Set<(event: CacheEvent) => void>();
  private readonly channel: BroadcastChannel | null;
  private readonly draftQueues = new Map<string, Promise<void>>();
  private readonly recoveryDrafts = new SnapshotMap();
  private readonly recoveryFences = new Map<string, Promise<CacheFence>>();
  /**
   * The lifecycle of each account this tab knows: as stored when it opened, or
   * as it signed in. A clear is meant for that lifecycle.
   */
  private readonly lifecycles = new Map<string, number>();
  private readonly lifecyclesLoaded: Promise<void>;
  /** Account lifecycle locks this tab holds while its clears are unresolved. */
  private readonly accountHolds = new Map<string, () => void>();
  /**
   * Clear operations by id: one per decision (a sign-out, revocation or
   * switch), reused by its retries, so a retry or a late attempt can never
   * restart a finished clear or retarget a later lifecycle.
   */
  private readonly clearOps = new Map<string, ClearOperation>();
  private closed = false;
  private readonly lockRequests = new AbortController();
  constructor(name = "palladian-notes-foundation") {
    this.db = new NotesDatabase(name);
    this.lifecyclesLoaded = this.db.accounts
      .toArray()
      .then((rows) => {
        for (const row of rows)
          if (!this.lifecycles.has(row.accountId))
            this.lifecycles.set(row.accountId, row.lifecycle ?? 0);
      })
      .catch(() => undefined);
    this.channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(name + ":invalidation");
    if (this.channel)
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (
          typeof value === "object" &&
          value !== null &&
          "revokedNotes" in value &&
          Array.isArray(value.revokedNotes) &&
          "accountId" in value &&
          typeof value.accountId === "string"
        ) {
          const ids = value.revokedNotes.filter(
            (id): id is string => typeof id === "string",
          );
          void this.receiveFences(value.accountId, ids, false);
          return;
        }
        if (
          typeof value === "object" &&
          value !== null &&
          "heldNotes" in value &&
          Array.isArray(value.heldNotes) &&
          "accountId" in value &&
          typeof value.accountId === "string"
        ) {
          const ids = value.heldNotes.filter(
            (id): id is string => typeof id === "string",
          );
          void this.receiveFences(value.accountId, ids, true);
          return;
        }
        if (
          typeof value === "object" &&
          value !== null &&
          "accountId" in value &&
          typeof value.accountId === "string"
        ) {
          void this.receiveClear(
            value.accountId,
            "lifecycle" in value && typeof value.lifecycle === "number"
              ? value.lifecycle
              : null,
          );
        }
      };
  }
  /**
   * Another tab fenced these notes. Messages can arrive late, after a fence was
   * lifted or replaced, so act only on fences of that kind still recorded:
   * revocation forgets this tab's unsaved snapshots; a hold keeps them and
   * closes editors of the notes and their conflict copies.
   */
  private async receiveFences(accountId: string, ids: string[], held: boolean) {
    try {
      const rows = await this.db.revoked.bulkGet(
        ids.map((id): [string, string] => [accountId, id]),
      );
      const current = ids.filter(
        (_, index) => rows[index] !== undefined && !!rows[index].held === held,
      );
      if (!current.length) return;
      if (!held) {
        this.forgetNotes(accountId, current);
        this.notify({ accountId, revokedNotes: current });
        return;
      }
      const gone = new Set(current);
      const drafts = await this.db.drafts
        .where("accountId")
        .equals(accountId)
        .toArray();
      const memory = [...this.recoveryDrafts.values()].filter(
        (draft) => draft.accountId === accountId,
      );
      const hidden = new Set([
        ...current,
        ...[...drafts, ...memory]
          .filter((draft) => isRevoked(gone, draft))
          .map((draft) => draft.id),
      ]);
      this.notify({ accountId, heldNotes: [...hidden] });
    } catch {
      /* the database is closing; nothing to act on */
    }
  }
  subscribe = (listener: (event: CacheEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify(event: CacheEvent = {}) {
    for (const listener of this.listeners) listener(event);
  }
  private epoch(accountId: string) {
    return this.epochs.get(accountId) ?? 0;
  }
  private assertWritable(accountId: string, epoch: number) {
    if (this.blocked.has(accountId) || this.epoch(accountId) !== epoch)
      throw new Error("Account access changed; local write was rejected.");
  }
  async list(accountId: string): Promise<NoteSummary[]> {
    if (this.blocked.has(accountId)) return [];
    const epoch = this.epoch(accountId);
    const persisted = await this.db.accounts.get(accountId);
    if (persisted?.blocked) return [];
    const memory = await this.recoverySnapshots(
      accountId,
      persisted?.epoch ?? 0,
    );
    const { value: listed, revoked } = await this.fenced(
      accountId,
      [this.db.summaries, this.db.drafts, this.db.accounts],
      async () => {
        // This reads only summaries, never all document bodies. A local
        // summary written by an older version may lack its copy's source.
        const rows = await this.db.summaries
          .where("accountId")
          .equals(accountId)
          .toArray();
        for (const row of rows)
          if (isLocalId(row.id) && row.source === undefined) {
            const source = (await this.db.drafts.get([accountId, row.id]))
              ?.source;
            if (source) row.source = source;
          }
        // Stored drafts of unsaved snapshots, so a newer stored one wins.
        const stored = new Map<string, Draft>();
        for (const draft of memory) {
          const row = await this.db.drafts.get([accountId, draft.id]);
          if (row) stored.set(draft.id, row);
        }
        const after = await this.db.accounts.get(accountId);
        return !after?.blocked &&
          (after?.epoch ?? 0) === (persisted?.epoch ?? 0)
          ? { rows, stored }
          : null;
      },
    );
    if (
      !listed ||
      this.epoch(accountId) !== epoch ||
      this.blocked.has(accountId)
    )
      return [];
    const { rows, stored } = listed;
    const visible = new Map(
      rows
        .filter((row) => !isRevoked(revoked, row))
        .map((row) => [row.id, row]),
    );
    for (const draft of memory)
      if (
        this.isCurrent(draft, stored.get(draft.id)) &&
        !isRevoked(revoked, draft)
      )
        visible.set(draft.id, {
          ...visible.get(draft.id),
          ...summary(draft),
          kind: "draft",
        });
    return [...visible.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async read(accountId: string, id: string): Promise<NoteBody | undefined> {
    if (this.blocked.has(accountId)) return undefined;
    const epoch = this.epoch(accountId);
    const persisted = await this.db.accounts.get(accountId);
    if (persisted?.blocked) return undefined;
    const captured = (
      await this.recoverySnapshots(accountId, persisted?.epoch ?? 0)
    ).find((value) => value.id === id);
    const { value, revoked } = await this.fenced(
      accountId,
      [this.db.drafts, this.db.bodies, this.db.accounts],
      async () => {
        const draft = await this.db.drafts.get([accountId, id]);
        const stored = await this.db.bodies.get([accountId, id]);
        const after = await this.db.accounts.get(accountId);
        const current =
          !after?.blocked && (after?.epoch ?? 0) === (persisted?.epoch ?? 0);
        return { draft, stored, current };
      },
    );
    const { draft, stored, current } = value;
    const recovered =
      captured && this.isCurrent(captured, draft) ? { ...captured } : undefined;
    if (
      !current ||
      this.epoch(accountId) !== epoch ||
      this.blocked.has(accountId) ||
      revoked.has(id) ||
      [recovered, draft].some((v) => v !== undefined && isRevoked(revoked, v))
    )
      return undefined;
    return recovered ?? draft ?? stored;
  }
  writeDraft(written: Draft): Promise<void> {
    const epoch = this.epoch(written.accountId);
    if (this.blocked.has(written.accountId))
      return Promise.reject(new Error("Account access changed"));
    const fence = this.captureFence(written.accountId);
    const key = JSON.stringify([written.accountId, written.id]);
    let draft = keepSyncState(written, this.recoveryDrafts.get(key));
    // Keep the latest editor snapshot even when quota prevents a durable write.
    this.recoveryDrafts.set(key, { ...draft });
    this.recoveryFences.set(key, fence);
    const previous = this.draftQueues.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const captured = await fence;
        this.assertWritable(draft.accountId, epoch);
        await this.db.transaction(
          "rw",
          [
            this.db.drafts,
            this.db.summaries,
            this.db.accounts,
            this.db.revoked,
          ],
          async () => {
            await this.assertPersistent(draft.accountId, captured.epoch);
            this.assertWritable(draft.accountId, epoch);
            await this.assertNotRevoked(draft.accountId, draft.id);
            const existing = await this.db.drafts.get([
              draft.accountId,
              draft.id,
            ]);
            const kept = keepSyncState(draft, existing);
            if (kept !== draft) {
              draft = kept;
              const latest = this.recoveryDrafts.get(key);
              if (latest && latest.updatedAt === draft.updatedAt)
                this.recoveryDrafts.set(key, keepSyncState(latest, existing));
            }
            if (draft.source)
              await this.assertNotRevoked(draft.accountId, draft.source);
            await this.db.drafts.put(draft);
            const previous = await this.db.summaries.get([
              draft.accountId,
              draft.id,
            ]);
            await this.db.summaries.put({
              ...previous,
              ...(draft.notebookId ? { notebookId: draft.notebookId } : {}),
              ...(draft.source ? { source: draft.source } : {}),
              ...summary(draft),
              kind: "draft",
            });
          },
        );
        // Saved: the stored draft is current now, including other tabs' saves.
        this.forgetSaved(key, draft);
        this.notify();
      });
    // Observe fence rejection immediately even if an older write is queued.
    void fence.catch(() => undefined);
    this.draftQueues.set(key, write);
    this.notify();
    void write
      .finally(() => {
        if (this.draftQueues.get(key) === write) this.draftQueues.delete(key);
      })
      .catch(() => undefined);
    return write;
  }
  /**
   * Run `work` unless another tab is already recovering this note. Tabs share
   * the database, so recovering one note at a time keeps an older snapshot in
   * one tab from racing a newer one in another; a skipped tab retries later.
   */
  async withRecoveryLock(
    accountId: string,
    id: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return work();
    await locks.request(
      JSON.stringify([this.db.name, "recovery", accountId, id]),
      { ifAvailable: true },
      async (lock) => {
        if (lock) await work();
      },
    );
  }
  /**
   * Replace a draft only if it is still exactly `expected`, with no newer
   * snapshot written meanwhile, durable or pending. Resolves whether it did.
   */
  replaceDraftIf(expected: Draft, next: Draft): Promise<boolean> {
    const epoch = this.epoch(next.accountId);
    if (this.blocked.has(next.accountId))
      return Promise.reject(new Error("Account access changed"));
    const fence = this.captureFence(next.accountId);
    const key = JSON.stringify([next.accountId, next.id]);
    const unchanged = (draft: Draft | undefined) =>
      sameSnapshot(draft, expected);
    const previous = this.draftQueues.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const captured = await fence;
        this.assertWritable(next.accountId, epoch);
        const memory = this.recoveryDrafts.get(key);
        if (memory && !unchanged(memory)) return false;
        const replaced = await this.db.transaction(
          "rw",
          [this.db.drafts, this.db.accounts, this.db.revoked],
          async () => {
            await this.assertPersistent(next.accountId, captured.epoch);
            this.assertWritable(next.accountId, epoch);
            await this.assertNotRevoked(next.accountId, next.id);
            const current = await this.db.drafts.get([next.accountId, next.id]);
            if (!unchanged(current)) return false;
            await this.db.drafts.put(next);
            return true;
          },
        );
        // Snapshots written while this was queued are newer; keep them.
        if (replaced && unchanged(this.recoveryDrafts.get(key))) {
          this.recoveryDrafts.delete(key);
          this.recoveryFences.delete(key);
        }
        if (replaced) this.notify();
        return replaced;
      });
    void fence.catch(() => undefined);
    const settled = write.then(() => undefined);
    this.draftQueues.set(key, settled);
    void settled
      .finally(() => {
        if (this.draftQueues.get(key) === settled) this.draftQueues.delete(key);
      })
      .catch(() => undefined);
    return write;
  }
  async captureFence(accountId: string): Promise<CacheFence> {
    const account = await this.db.accounts.get(accountId);
    if (this.blocked.has(accountId) || account?.blocked)
      throw new Error("Account cache is invalidated.");
    return { accountId, epoch: account?.epoch ?? 0 };
  }
  async cacheAccepted(
    body: NoteBody,
    updatedAt: number,
    fence: CacheFence,
  ): Promise<void> {
    if (fence.accountId !== body.accountId)
      throw new Error("Account cache fence does not match.");
    const epoch = this.epoch(body.accountId);
    this.assertWritable(body.accountId, epoch);

    await this.db.transaction(
      "rw",
      [
        this.db.bodies,
        this.db.summaries,
        this.db.drafts,
        this.db.accounts,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(body.accountId, fence.epoch);
        this.assertWritable(body.accountId, epoch);
        await this.assertNotRevoked(body.accountId, body.id);
        await this.db.bodies.put(body);
        // Accepted refresh must not overwrite unsaved local recovery content.
        if (!(await this.db.drafts.get([body.accountId, body.id]))) {
          const previous = await this.db.summaries.get([
            body.accountId,
            body.id,
          ]);
          await this.db.summaries.put({
            ...previous,
            ...summary({ ...body, updatedAt }),
            kind: "cached",
          });
        }
      },
    );
    this.notify();
  }
  /** Fence writes immediately, then clear transactionally. Re-enable only on a new authorized login. */
  /**
   * End this account's local lifecycle: block it, then delete its data. The
   * clear holds the account's lifecycle lock from its start until it succeeds,
   * across retries (made in the background too), so no tab can sign the
   * account in meanwhile. The block commits first on its own, so a failed
   * deletion still leaves it, and any later activation deletes the data before
   * unblocking; nothing can be written for a blocked account, so its data is
   * always an ended lifecycle's. A clear decided for a lifecycle that another
   * tab has since replaced by signing in again does nothing. Resolves whether
   * the account was cleared.
   */
  async clearAccount(
    accountId: string,
    operation: string = crypto.randomUUID(),
  ): Promise<boolean> {
    if (!this.clearOps.has(operation)) {
      await this.lifecyclesLoaded;
      if (!this.clearOps.has(operation)) {
        this.clearOps.set(operation, {
          accountId,
          lifecycle: this.lifecycles.get(accountId),
          result: null,
          attempts: 0,
        });
        this.hideAccount(accountId);
      }
    }
    const op = this.clearOps.get(operation)!;
    if (op.result !== null) return op.result;
    // A retry while an attempt is running joins it rather than racing it.
    op.running ??= this.attemptClear(op).finally(() => {
      op.running = undefined;
    });
    return op.running;
  }
  private async attemptClear(op: ClearOperation): Promise<boolean> {
    clearTimeout(op.retry);
    const { accountId } = op;
    try {
      await this.holdAccount(accountId);
      const ended = await this.db.transaction(
        "rw",
        [this.db.accounts, this.db.privacy],
        async () => {
          const account = await this.db.accounts.get(accountId);
          const lifecycle = account?.lifecycle ?? 0;
          // Fixed at its first read under the lock: no tab can begin another
          // lifecycle while this tab holds it.
          op.lifecycle ??= lifecycle;
          if (lifecycle !== op.lifecycle) throw new SupersededClear();
          if (account?.blocked) return null;
          const privacy = await this.db.privacy.get("activation");
          await this.db.privacy.put({
            key: "activation",
            epoch: (privacy?.epoch ?? 0) + 1,
          });
          await this.db.accounts.put({
            ...account,
            accountId,
            epoch: (account?.epoch ?? 0) + 1,
            blocked: true,
          });
          return lifecycle;
        },
      );
      // Other tabs learn once, when the block is first recorded, which
      // lifecycle ended.
      if (ended !== null)
        this.channel?.postMessage({ accountId, lifecycle: ended });
      await this.deleteIfBlocked(accountId);
    } catch (error) {
      if (error instanceof SupersededClear) {
        this.settleClear(op, false);
        return false;
      }
      if (!this.closed) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(++op.attempts, 5));
        op.retry = setTimeout(() => {
          if (op.result !== null || op.running) return;
          // Callers that join this attempt must see its failure; only this
          // background start ignores it (its own retry follows).
          const running = this.attemptClear(op).finally(() => {
            op.running = undefined;
          });
          op.running = running;
          void running.catch(() => undefined);
        }, delay);
      }
      throw error;
    }
    this.settleClear(op, true);
    return true;
  }
  /**
   * Finish an operation, and every unfinished one in this tab for the same
   * account and lifecycle, which had the same goal; then release the lock.
   */
  private settleClear(op: ClearOperation, result: boolean) {
    for (const other of this.clearOps.values())
      if (
        other === op ||
        (other.result === null &&
          other.accountId === op.accountId &&
          (other.lifecycle === undefined || other.lifecycle === op.lifecycle))
      ) {
        other.result = result;
        clearTimeout(other.retry);
      }
    if (
      ![...this.clearOps.values()].some(
        (other) => other.accountId === op.accountId && other.result === null,
      )
    )
      this.releaseAccount(op.accountId);
  }
  /**
   * Finish a clear recorded by an earlier page or another tab: delete the
   * account's data if it is still blocked. A tab holding the account's lock
   * finishes it itself. Resolves whether anything was deleted.
   */
  async finishClear(accountId: string): Promise<boolean> {
    const result = await this.ifAccountFree(accountId, () =>
      this.deleteIfBlocked(accountId),
    );
    return result.ran && result.value;
  }
  /** Delete a blocked account's data in one transaction; resolves whether it was blocked. */
  private async deleteIfBlocked(accountId: string): Promise<boolean> {
    const cleared = await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.notebooks,
        this.db.cursors,
        this.db.revoked,
      ],
      async () => {
        if (!(await this.db.accounts.get(accountId))?.blocked) return false;
        await this.deleteAccountData(accountId);
        return true;
      },
    );
    if (cleared) this.notify();
    return cleared;
  }
  /** Inside a transaction over every account-scoped table. */
  private async deleteAccountData(accountId: string) {
    for (const table of [
      this.db.notebooks,
      this.db.cursors,
      this.db.revoked,
      this.db.summaries,
      this.db.bodies,
      this.db.drafts,
    ])
      await table.where("accountId").equals(accountId).delete();
  }
  /**
   * Stop showing this account's content in this tab, and unless asked to keep
   * them, forget its unsaved in-memory snapshots too.
   */
  private hideAccount(accountId: string, keepRecovery = false) {
    this.activationEpoch++;
    this.blocked.add(accountId);
    if (!keepRecovery) this.forgetRecovery(accountId);
    this.epochs.set(accountId, this.epoch(accountId) + 1);
    this.notify({ accountId, invalidated: true });
  }
  /**
   * Another tab ended one of this account's lifecycles. A message about a
   * lifecycle older than the one this tab signed in to is late and ignored;
   * otherwise this tab stops showing the account at once. A message from an
   * older version names no lifecycle and may be late: it hides the account but
   * keeps this tab's unsaved snapshots, which stay unreadable unless this
   * lifecycle is signed in to again.
   */
  private async receiveClear(accountId: string, lifecycle: number | null) {
    await this.lifecyclesLoaded;
    const mine = this.lifecycles.get(accountId);
    if (lifecycle === null) return this.hideAccount(accountId, true);
    if (mine !== undefined && mine > lifecycle) return;
    this.hideAccount(accountId);
  }
  private accountLock(accountId: string) {
    return JSON.stringify([this.db.name, "account", accountId]);
  }
  /** Acquire the account's lifecycle lock and keep it until `releaseAccount`. */
  private async holdAccount(accountId: string) {
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (this.closed) throw new Error("The notes store is closed.");
    if (!locks || this.accountHolds.has(accountId)) return;
    await new Promise<void>((acquired, failed) => {
      locks
        .request(
          this.accountLock(accountId),
          { signal: this.lockRequests.signal },
          () => {
            // Granted after close: give it straight back.
            if (this.closed) {
              failed(new Error("The notes store is closed."));
              return;
            }
            return new Promise<void>((release) => {
              this.accountHolds.set(accountId, release);
              acquired();
            });
          },
        )
        .catch(failed);
    });
  }
  private releaseAccount(accountId: string) {
    this.accountHolds.get(accountId)?.();
    this.accountHolds.delete(accountId);
  }
  /**
   * Run `work` sharing the account's lifecycle lock (activations and finishing
   * may overlap; the database orders them), unless a clear holds it.
   */
  private async ifAccountFree<T>(
    accountId: string,
    work: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks || this.accountHolds.has(accountId))
      return { ran: true, value: await work() };
    return locks.request(
      this.accountLock(accountId),
      { mode: "shared", ifAvailable: true },
      async (lock): Promise<{ ran: true; value: T } | { ran: false }> =>
        lock ? { ran: true, value: await work() } : { ran: false },
    );
  }
  /**
   * Whether this tab holds typing for the account that is not stored durably
   * yet: a draft write still queued, or one that failed (for example when
   * storage is full). Waits for queued writes first. Read-only.
   */
  async hasUndurableWork(accountId: string): Promise<boolean> {
    await Promise.all(
      [...this.draftQueues.values()].map((queue) =>
        queue.catch(() => undefined),
      ),
    );
    for (const draft of this.recoveryDrafts.values())
      if (draft.accountId === accountId) return true;
    return false;
  }
  /** Whether unsaved work is kept for this account; see `unsavedWork`. */
  async hasDrafts(accountId: string) {
    return (await this.unsavedWork(accountId)).total > 0;
  }
  /**
   * Unsaved work kept for this account, including work on notes held while the
   * server confirms access: it is kept but cannot be exported until then.
   */
  async unsavedWork(
    accountId: string,
  ): Promise<{ total: number; held: number }> {
    if (this.blocked.has(accountId)) return { total: 0, held: 0 };
    const { total, held } = await this.settlement(accountId);
    return { total, held };
  }
  async exportDrafts(accountId: string): Promise<Draft[]> {
    return (await this.settlement(accountId)).drafts;
  }
  /**
   * Everything signing out must account for, read at one point: the drafts an
   * export contains, and how much kept work is held and so cannot be exported.
   * Work on notes this account lost access to, or whose access the server has
   * yet to confirm, is never exportable.
   */
  async settlement(
    accountId: string,
  ): Promise<{ drafts: Draft[]; total: number; held: number }> {
    // Unsaved snapshots live outside the database transaction, so a read that
    // overlapped a change to them is repeated rather than trusted.
    for (let attempt = 0; attempt < 5; attempt++) {
      const version = this.recoveryDrafts.version;
      const result = await this.readSettlement(accountId);
      if (this.recoveryDrafts.version === version) return result;
    }
    throw new Error("Unsaved work kept changing; try again.");
  }
  private async readSettlement(
    accountId: string,
  ): Promise<{ drafts: Draft[]; total: number; held: number }> {
    const epoch = this.epoch(accountId);
    const fence = await this.captureFence(accountId);
    await Promise.allSettled([...this.draftQueues.values()]);
    const captured = await this.recoverySnapshots(accountId, fence.epoch);
    const {
      value: stored,
      revoked,
      held,
    } = await this.fenced(
      accountId,
      [this.db.drafts, this.db.accounts],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        return this.db.drafts.where("accountId").equals(accountId).toArray();
      },
    );
    this.assertWritable(accountId, epoch);
    const byId = new Map(stored.map((draft) => [draft.id, draft]));
    const latest = new Map(byId);
    for (const draft of captured)
      if (this.isCurrent(draft, byId.get(draft.id)))
        latest.set(draft.id, { ...draft });
    const denied = new Set([...revoked].filter((id) => !held.has(id)));
    const kept = [...latest.values()].filter((d) => !isRevoked(denied, d));
    return {
      drafts: kept.filter((draft) => !isRevoked(revoked, draft)),
      total: kept.length,
      held: kept.filter((draft) => isRevoked(held, draft)).length,
    };
  }
  /**
   * Forget this tab's unsaved snapshots of an account taken in any epoch but
   * `epoch`: they belong to a lifecycle that has ended, and nothing (sticky
   * fields, compare-and-replace, splits) may act on them.
   */
  private async forgetOtherEpochs(accountId: string, epoch: number) {
    for (const [key, draft] of [...this.recoveryDrafts]) {
      if (draft.accountId !== accountId) continue;
      const fence = await this.recoveryFences.get(key)?.catch(() => null);
      if (fence?.epoch !== epoch && this.recoveryDrafts.get(key) === draft) {
        this.recoveryDrafts.delete(key);
        this.recoveryFences.delete(key);
      }
    }
  }
  /** A snapshot kept in memory only until it is saved. */
  private forgetSaved(key: string, saved: Draft) {
    if (sameSnapshot(this.recoveryDrafts.get(key), saved)) {
      this.recoveryDrafts.delete(key);
      this.recoveryFences.delete(key);
    }
  }
  private forgetRecovery(accountId: string) {
    for (const [key, draft] of this.recoveryDrafts)
      if (draft.accountId === accountId) {
        this.recoveryDrafts.delete(key);
        this.recoveryFences.delete(key);
      }
  }
  /**
   * This account's unsaved in-memory snapshots for the current epoch. Callers
   * read their rows and fences afterwards, then keep a snapshot only if it is
   * still unsaved (`isCurrent`), newer than its stored draft, and not fenced.
   */
  private async recoverySnapshots(
    accountId: string,
    epoch: number,
  ): Promise<Draft[]> {
    const drafts: Draft[] = [];
    for (const [key, draft] of this.recoveryDrafts) {
      if (draft.accountId !== accountId) continue;
      const fence = await this.recoveryFences.get(key)?.catch(() => null);
      if (
        fence?.epoch === epoch &&
        !this.blocked.has(accountId) &&
        this.recoveryDrafts.get(key) === draft
      )
        drafts.push(draft);
    }
    return drafts;
  }
  /**
   * A captured snapshot that is still this tab's unsaved version, and newer
   * than the stored draft read since: a saved or replaced one is not revived.
   */
  private isCurrent(snapshot: Draft, stored: Draft | undefined) {
    return (
      this.recoveryDrafts.get(
        JSON.stringify([snapshot.accountId, snapshot.id]),
      ) === snapshot &&
      (stored === undefined || snapshot.updatedAt >= stored.updatedAt)
    );
  }
  /**
   * Run `read` in one IndexedDB transaction with the account's note fences, so
   * a fence recorded in any tab is either seen by the read or committed after
   * it. `held` is the subset whose access the server has yet to confirm.
   */
  private fenced<T>(
    accountId: string,
    tables: Table[],
    read: () => Promise<T>,
  ): Promise<{ value: T; revoked: Set<string>; held: Set<string> }> {
    return this.db.transaction("r", [...tables, this.db.revoked], async () => {
      const value = await read();
      const rows = await this.db.revoked
        .where("accountId")
        .equals(accountId)
        .toArray();
      return {
        value,
        revoked: new Set(rows.map((row) => row.id)),
        held: new Set(rows.filter((row) => row.held).map((row) => row.id)),
      };
    });
  }
  /** Which of these notes are fenced: revoked, or held while access is checked. */
  async fencedNotes(accountId: string, ids: string[]): Promise<Set<string>> {
    const rows = await this.db.revoked.bulkGet(
      ids.map((id): [string, string] => [accountId, id]),
    );
    return new Set(ids.filter((_, index) => rows[index] !== undefined));
  }
  private async revokedIds(accountId: string) {
    const rows = await this.db.revoked
      .where("accountId")
      .equals(accountId)
      .toArray();
    return new Set(rows.map((row) => row.id));
  }
  invalidateAccount(accountId: string) {
    return this.clearAccount(accountId);
  }
  async captureActivationFence(): Promise<ActivationFence> {
    const localEpoch = this.activationEpoch;
    const privacy = await this.db.privacy.get("activation");
    return { epoch: privacy?.epoch ?? 0, localEpoch };
  }
  async allowAccount(
    accountId: string,
    fence: ActivationFence,
    isCurrent: () => boolean,
  ) {
    const assertCurrent = () => {
      if (!isCurrent() || this.activationEpoch !== fence.localEpoch)
        throw new Error("Session activation was superseded.");
    };
    assertCurrent();
    // This tab's own unfinished clear must complete before any sign-in.
    for (const op of this.clearOps.values())
      if (op.accountId === accountId && op.result === null)
        throw new Error("This account is still being cleared.");
    let lifecycle = 0;
    let epoch = 0;
    let ended = false;
    const activated = await this.ifAccountFree(accountId, () =>
      this.db.transaction(
        "rw",
        [
          this.db.accounts,
          this.db.privacy,
          this.db.summaries,
          this.db.bodies,
          this.db.drafts,
          this.db.notebooks,
          this.db.cursors,
          this.db.revoked,
        ],
        async () => {
          const privacy = await this.db.privacy.get("activation");
          const account = await this.db.accounts.get(accountId);
          assertCurrent();
          if ((privacy?.epoch ?? 0) !== fence.epoch)
            throw new Error("Session activation was invalidated.");
          // A blocked account's data belongs to an ended lifecycle: never revived.
          if (account?.blocked) {
            ended = true;
            await this.deleteAccountData(accountId);
          }
          await this.db.accounts.put({
            accountId,
            epoch: (epoch = (account?.epoch ?? 0) + (account?.blocked ? 1 : 0)),
            blocked: false,
            // Tabs signing in to the same lifecycle share it; signing in after a
            // clear begins the next one.
            lifecycle: (lifecycle =
              (account?.lifecycle ?? 0) + (account?.blocked ? 1 : 0)),
          });
        },
      ),
    );
    if (!activated.ran)
      throw new Error("Another tab is still clearing this account.");
    assertCurrent();
    // Snapshots kept from an ended lifecycle stay ended, including those
    // from an epoch another tab already moved past by signing in first.
    if (ended) this.forgetRecovery(accountId);
    else await this.forgetOtherEpochs(accountId, epoch);
    assertCurrent();
    this.blocked.delete(accountId);
    this.lifecycles.set(accountId, lifecycle);
    this.notify();
  }
  private async assertPersistent(accountId: string, epoch: number) {
    const account = await this.db.accounts.get(accountId);
    if (account?.blocked || (account?.epoch ?? 0) !== epoch)
      throw new Error("Account access changed; local write was rejected.");
  }
  /** Apply library feed rows. Unsaved local recovery keeps its own title. */
  async cacheSummaries(
    accountId: string,
    rows: RemoteSummary[],
    removed: string[],
    fence: CacheFence,
    cursor?: { key: string; value: number },
  ): Promise<string[]> {
    if (fence.accountId !== accountId)
      throw new Error("Account cache fence does not match.");
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    const fenced: string[] = [];
    let revoked: string[] = [];
    await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.cursors,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        for (const row of rows) {
          // A summary may be older than a revocation; only a fresh access check
          // (allowNotes) lifts a fence. Report fenced rows instead of caching them.
          if (await this.db.revoked.get([accountId, row.id])) {
            fenced.push(row.id);
            continue;
          }
          const draft = await this.db.drafts.get([accountId, row.id]);
          const previous = await this.db.summaries.get([accountId, row.id]);
          await this.db.summaries.put({
            accountId,
            id: row.id,
            title: draft && previous ? previous.title : row.title,
            preview: draft && previous ? previous.preview : row.preview,
            updatedAt:
              draft && previous
                ? Math.max(previous.updatedAt, row.updatedAt)
                : row.updatedAt,
            kind: draft ? "draft" : "cached",
            notebookId: row.notebookId,
            role: row.role,
            trashed: row.trashed,
          });
        }
        // Lost access removes cached content and any pending work for it.
        revoked = await this.fenceNotes(accountId, removed);
        if (cursor)
          await this.db.cursors.put({
            accountId,
            key: cursor.key,
            value: cursor.value,
          });
      },
    );
    this.announceRevoked(accountId, revoked);
    this.notify();
    return fenced;
  }
  /**
   * The current revocation marker of each fenced note. Capture these before
   * asking the server; `allowNotes` lifts only markers that are unchanged.
   */
  async revocationMarkers(
    accountId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const markers = new Map<string, string>();
    for (const id of ids) {
      const marker = await this.db.revoked.get([accountId, id]);
      if (marker) markers.set(id, marker.nonce ?? "");
    }
    return markers;
  }
  /** Held fences and their markers: notes whose access the server must confirm. */
  async heldMarkers(accountId: string): Promise<Map<string, string>> {
    const rows = await this.db.revoked
      .where("accountId")
      .equals(accountId)
      .toArray();
    return new Map(
      rows.filter((row) => row.held).map((row) => [row.id, row.nonce ?? ""]),
    );
  }
  /**
   * The server denied access to held notes: remove their local work. Only a
   * fence still exactly as captured before the request is acted on.
   */
  async purgeHeld(
    accountId: string,
    denied: { id: string; marker: string }[],
    fence: CacheFence,
  ): Promise<void> {
    if (fence.accountId !== accountId)
      throw new Error("Account cache fence does not match.");
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    let revoked: string[] = [];
    await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        const ids: string[] = [];
        for (const { id, marker } of denied) {
          const current = await this.db.revoked.get([accountId, id]);
          if (current?.held && (current.nonce ?? "") === marker) ids.push(id);
        }
        revoked = await this.fenceNotes(accountId, ids);
      },
    );
    this.announceRevoked(accountId, revoked);
    this.notify();
  }
  /**
   * Lift fences the server has since confirmed accessible. Each confirmation
   * names the marker captured before its request was sent; a revocation
   * recorded since then replaced that marker and stays.
   */
  async allowNotes(
    accountId: string,
    confirmed: { id: string; marker: string }[],
    fence: CacheFence,
  ): Promise<void> {
    if (fence.accountId !== accountId)
      throw new Error("Account cache fence does not match.");
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    await this.db.transaction(
      "rw",
      [this.db.revoked, this.db.accounts],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        for (const { id, marker } of confirmed) {
          const current = await this.db.revoked.get([accountId, id]);
          if (current && (current.nonce ?? "") === marker)
            await this.db.revoked.delete([accountId, id]);
        }
      },
    );
  }
  /**
   * Delete notes' local copies, and conflict copies made from them, and record
   * persistent fences. Inside a transaction. Returns every fenced ID.
   */
  private async fenceNotes(accountId: string, ids: string[]) {
    if (!ids.length) return [];
    const at = Date.now();
    const gone = new Set(ids);
    const copies = (
      await this.db.drafts.where("accountId").equals(accountId).toArray()
    )
      .filter(
        (draft) =>
          draft.source !== undefined &&
          gone.has(draft.source) &&
          !gone.has(draft.id),
      )
      .map((draft) => draft.id);
    const fenced = [...ids, ...copies];
    for (const id of fenced) {
      await this.db.summaries.delete([accountId, id]);
      await this.db.bodies.delete([accountId, id]);
      await this.db.drafts.delete([accountId, id]);
      await this.db.revoked.put({
        accountId,
        id,
        at,
        nonce: crypto.randomUUID(),
      });
    }
    return fenced;
  }
  /**
   * Hide notes whose access is in doubt without deleting their local work:
   * nothing is readable, exportable or sent until the server confirms access
   * (lifting the fence) or denies it (`purgeHeld`). Inside a transaction.
   */
  private async holdNotes(accountId: string, ids: string[]) {
    const at = Date.now();
    for (const id of ids)
      await this.db.revoked.put({
        accountId,
        id,
        at,
        nonce: crypto.randomUUID(),
        held: true,
      });
  }
  private announceRevoked(accountId: string, ids: string[]) {
    if (!ids.length) return;
    this.forgetNotes(accountId, ids);
    this.channel?.postMessage({ accountId, revokedNotes: ids });
    this.notify({ accountId, revokedNotes: ids });
  }
  private forgetNotes(accountId: string, ids: string[]) {
    const gone = new Set(ids);
    for (const [key, draft] of this.recoveryDrafts)
      if (draft.accountId === accountId && isRevoked(gone, draft)) {
        this.recoveryDrafts.delete(key);
        this.recoveryFences.delete(key);
      }
    for (const id of ids) {
      const key = JSON.stringify([accountId, id]);
      this.recoveryDrafts.delete(key);
      this.recoveryFences.delete(key);
    }
  }
  private async assertNotRevoked(accountId: string, id: string) {
    if (await this.db.revoked.get([accountId, id]))
      throw new Error("Access to this note was removed.");
  }
  /** This account lost access to these notes: remove every local copy, in every tab. */
  async revokeNotes(accountId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const fence = await this.captureFence(accountId);
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    this.forgetNotes(accountId, ids);
    let fenced = ids;
    await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        fenced = await this.fenceNotes(accountId, ids);
      },
    );
    this.announceRevoked(accountId, fenced);
    this.notify();
  }
  /**
   * Reconcile cached server notes against one complete authorization snapshot:
   * a note survives if its notebook is visible or it is shared individually.
   * That includes notes this device created whose summary has not arrived, once
   * their notebook is known. A conflict copy survives only if its source note
   * would. Local notes never sent to the server are kept. A cached notebook can
   * be out of date (the note may have moved), and other tabs may hold unsaved
   * work this one cannot see, so nothing is deleted here: lost notes are held,
   * hidden everywhere, until the server confirms or denies access. Cached text
   * of a held note without saved work is dropped; a confirmed note fetches it
   * again. Resolves the held note IDs.
   */
  async reconcileAccess(
    accountId: string,
    visibleNotebooks: Set<string>,
    sharedNotes: Set<string>,
    fence: CacheFence,
  ): Promise<string[]> {
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    let held: string[] = [];
    let hidden: string[] = [];
    await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.revoked,
        this.db.cursors,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        const rows = await this.db.summaries
          .where("accountId")
          .equals(accountId)
          .toArray();
        const drafts = await this.db.drafts
          .where("accountId")
          .equals(accountId)
          .toArray();
        const reachable = (id: string, notebookId: string | undefined) =>
          sharedNotes.has(id) ||
          (notebookId !== undefined && visibleNotebooks.has(notebookId));
        const notebookOf = new Map(rows.map((row) => [row.id, row.notebookId]));
        const lost = rows
          .filter(
            (row) =>
              (row.role !== undefined ||
                (!isLocalId(row.id) && row.notebookId !== undefined)) &&
              !reachable(row.id, row.notebookId),
          )
          .map((row) => row.id);
        for (const draft of drafts) {
          if (draft.source === undefined) continue;
          const notebookId = notebookOf.get(draft.source) ?? draft.notebookId;
          if (notebookId !== undefined && !reachable(draft.source, notebookId))
            lost.push(draft.source);
        }
        const already = await this.revokedIds(accountId);
        held = [...new Set(lost)].filter((id) => !already.has(id));
        await this.holdNotes(accountId, held);
        const gone = new Set(held);
        const saved = new Set(
          drafts.flatMap((draft) =>
            draft.source === undefined ? [draft.id] : [draft.id, draft.source],
          ),
        );
        for (const id of held)
          if (!saved.has(id)) {
            await this.db.summaries.delete([accountId, id]);
            await this.db.bodies.delete([accountId, id]);
          }
        const memory = [...this.recoveryDrafts.values()].filter(
          (draft) => draft.accountId === accountId,
        );
        hidden = [
          ...new Set([
            ...held,
            ...[...drafts, ...memory]
              .filter((draft) => isRevoked(gone, draft))
              .map((draft) => draft.id),
          ]),
        ];
        // Feeds for notebooks no longer visible restart from scratch if re-shared.
        const cursors = await this.db.cursors
          .where("accountId")
          .equals(accountId)
          .toArray();
        for (const cursor of cursors)
          if (
            cursor.key.startsWith("notebook:") &&
            !visibleNotebooks.has(cursor.key.slice("notebook:".length))
          )
            await this.db.cursors.delete([accountId, cursor.key]);
      },
    );
    if (held.length) {
      // Every tab closes editors of held notes and their copies, keeping work.
      this.channel?.postMessage({ accountId, heldNotes: held });
      this.notify({ accountId, heldNotes: hidden });
    }
    return held;
  }
  async cursor(accountId: string, key: string): Promise<number> {
    return (await this.db.cursors.get([accountId, key]))?.value ?? 0;
  }
  async notebooks(accountId: string): Promise<CachedNotebook[]> {
    if (this.blocked.has(accountId)) return [];
    const rows = await this.db.notebooks
      .where("accountId")
      .equals(accountId)
      .toArray();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Replace the notebook list. Note access is reconciled separately. */
  async setNotebooks(
    accountId: string,
    notebooks: Omit<CachedNotebook, "accountId">[],
    fence: CacheFence,
  ): Promise<void> {
    if (fence.accountId !== accountId)
      throw new Error("Account cache fence does not match.");
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    await this.db.transaction(
      "rw",
      [this.db.notebooks, this.db.accounts],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        await this.db.notebooks.where("accountId").equals(accountId).delete();
        await this.db.notebooks.bulkPut(
          notebooks.map((n) => ({ ...n, accountId })),
        );
      },
    );
    this.notify();
  }
  async bodyRevision(accountId: string, id: string): Promise<number | null> {
    const body = await this.db.bodies.get([accountId, id]);
    return body?.revision ?? null;
  }
  async summaryRows(accountId: string): Promise<NoteSummary[]> {
    if (this.blocked.has(accountId)) return [];
    return this.db.summaries.where("accountId").equals(accountId).toArray();
  }
  async readDraft(accountId: string, id: string): Promise<Draft | undefined> {
    if (this.blocked.has(accountId)) return undefined;
    const key = JSON.stringify([accountId, id]);
    const { value, revoked } = await this.fenced(
      accountId,
      [this.db.drafts, this.db.accounts],
      async () => ({
        stored: await this.db.drafts.get([accountId, id]),
        epoch: (await this.db.accounts.get(accountId))?.epoch ?? 0,
      }),
    );
    // This tab's unsaved snapshot, if any, as of now: only one taken in the
    // account's current epoch, and only if no newer draft is stored.
    let memory = this.recoveryDrafts.get(key);
    if (memory) {
      const fence = await this.recoveryFences.get(key)?.catch(() => null);
      if (
        fence?.epoch !== value.epoch ||
        this.recoveryDrafts.get(key) !== memory
      )
        memory = undefined;
    }
    const { stored } = value;
    const draft =
      memory && (!stored || memory.updatedAt >= stored.updatedAt)
        ? memory
        : stored;
    return draft && !isRevoked(revoked, draft) ? draft : undefined;
  }
  async localDrafts(accountId: string): Promise<Draft[]> {
    if (this.blocked.has(accountId)) return [];
    const { value: rows, revoked } = await this.fenced(
      accountId,
      [this.db.drafts],
      () => this.db.drafts.where("accountId").equals(accountId).toArray(),
    );
    return rows.filter(
      (draft) =>
        draft.baseRevision === undefined &&
        draft.created !== true &&
        isLocalId(draft.id) &&
        !isRevoked(revoked, draft),
    );
  }
  /** Drafts created on the server whose content has not been reconciled yet. */
  async adoptedDrafts(accountId: string): Promise<Draft[]> {
    if (this.blocked.has(accountId)) return [];
    const { value: rows, revoked } = await this.fenced(
      accountId,
      [this.db.drafts],
      () => this.db.drafts.where("accountId").equals(accountId).toArray(),
    );
    // A server ID means the note exists, whichever editor saved the draft.
    return rows.filter(
      (draft) =>
        draft.baseRevision === undefined &&
        (draft.created === true || !isLocalId(draft.id)) &&
        !isRevoked(revoked, draft),
    );
  }
  /**
   * Retire a journal entry once the server accepted everything in it, keeping
   * the accepted document as the cached body. A newer entry is left alone.
   */
  async settleDraft(
    accountId: string,
    id: string,
    accepted: NoteBody & { revision: number },
    updatedAt: number,
    expected: Draft | null,
    fence: CacheFence,
  ): Promise<void> {
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    const key = JSON.stringify([accountId, id]);
    await Promise.allSettled([this.draftQueues.get(key)]);
    await this.db.transaction(
      "rw",
      [
        this.db.drafts,
        this.db.summaries,
        this.db.bodies,
        this.db.accounts,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        await this.assertNotRevoked(accountId, id);
        const current = await this.db.drafts.get([accountId, id]);
        if (expected && current && !sameSnapshot(current, expected)) return;
        await this.db.drafts.delete([accountId, id]);
        await this.db.bodies.put({ ...accepted, accountId, id });
        const previous = await this.db.summaries.get([accountId, id]);
        await this.db.summaries.put({
          ...previous,
          ...summary({ ...accepted, accountId, id, updatedAt }),
          kind: "cached",
        });
      },
    );
    const memory = this.recoveryDrafts.get(key);
    if (memory && (!expected || sameSnapshot(memory, expected))) {
      this.recoveryDrafts.delete(key);
      this.recoveryFences.delete(key);
    }
    this.notify();
  }
  /**
   * Keep both versions when local work cannot be merged safely: the note
   * becomes the server's accepted version, and the local content moves to a
   * new local draft that will be created as a separate note. The copy keeps
   * the note as its source until then. Only if the draft is still exactly
   * `expected`; resolves whether it split.
   */
  splitConflict(
    expected: Draft,
    copyId: string,
    accepted: NoteBody & { revision: number },
    fence: CacheFence,
  ): Promise<boolean> {
    const { accountId, id } = expected;
    const epoch = this.epoch(accountId);
    if (this.blocked.has(accountId))
      return Promise.reject(new Error("Account access changed"));
    const key = JSON.stringify([accountId, id]);
    const unchanged = (draft: Draft | undefined) =>
      sameSnapshot(draft, expected);
    const previous = this.draftQueues.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        this.assertWritable(accountId, epoch);
        const memory = this.recoveryDrafts.get(key);
        if (memory && !unchanged(memory)) return false;
        const split = await this.db.transaction(
          "rw",
          [
            this.db.drafts,
            this.db.summaries,
            this.db.bodies,
            this.db.accounts,
            this.db.revoked,
          ],
          async () => {
            await this.assertPersistent(accountId, fence.epoch);
            this.assertWritable(accountId, epoch);
            await this.assertNotRevoked(accountId, id);
            if (!unchanged(await this.db.drafts.get([accountId, id])))
              return false;
            const row = await this.db.summaries.get([accountId, id]);
            const notebookId = expected.notebookId ?? row?.notebookId;
            const copy: Draft = {
              accountId,
              id: copyId,
              document: expected.document,
              text: expected.text,
              updatedAt: Date.now(),
              ...(notebookId ? { notebookId } : {}),
              source: id,
            };
            await this.db.drafts.put(copy);
            await this.db.summaries.put({
              ...(notebookId ? { notebookId } : {}),
              ...summary(copy),
              kind: "draft",
              source: id,
            });
            await this.db.drafts.delete([accountId, id]);
            await this.db.bodies.put({ ...accepted, accountId, id });
            await this.db.summaries.put({
              ...row,
              ...summary({ ...accepted, accountId, id, updatedAt: Date.now() }),
              kind: "cached",
            });
            return true;
          },
        );
        if (split && unchanged(this.recoveryDrafts.get(key))) {
          this.recoveryDrafts.delete(key);
          this.recoveryFences.delete(key);
        }
        if (split) this.notify();
        return split;
      });
    const settled = write.then(() => undefined);
    this.draftQueues.set(key, settled);
    void settled
      .finally(() => {
        if (this.draftQueues.get(key) === settled) this.draftQueues.delete(key);
      })
      .catch(() => undefined);
    return write;
  }
  /** Move a local note's records to the ID the server assigned. */
  async adoptServerId(
    accountId: string,
    localId: string,
    noteId: string,
    fence: CacheFence,
  ): Promise<void> {
    const epoch = this.epoch(accountId);
    this.assertWritable(accountId, epoch);
    const oldKey = JSON.stringify([accountId, localId]);
    await Promise.allSettled([this.draftQueues.get(oldKey)]);
    await this.db.transaction(
      "rw",
      [
        this.db.drafts,
        this.db.summaries,
        this.db.bodies,
        this.db.accounts,
        this.db.revoked,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        await this.assertNotRevoked(accountId, noteId);
        const draft = await this.db.drafts.get([accountId, localId]);
        const row = await this.db.summaries.get([accountId, localId]);
        const body = await this.db.bodies.get([accountId, localId]);
        // Adopted drafts are created: they are reconciled, never created again.
        // A created copy is a note of its own, authorized by the server.
        if (draft) await this.db.drafts.put(adopted(draft, noteId));
        if (row) {
          const { source: _source, ...rest } = row;
          await this.db.summaries.put({ ...rest, id: noteId });
        }
        if (body) await this.db.bodies.put({ ...body, id: noteId });
        await this.db.drafts.delete([accountId, localId]);
        await this.db.summaries.delete([accountId, localId]);
        await this.db.bodies.delete([accountId, localId]);
      },
    );
    const memory = this.recoveryDrafts.get(oldKey);
    if (memory) {
      const fenceValue = this.recoveryFences.get(oldKey);
      this.recoveryDrafts.delete(oldKey);
      this.recoveryFences.delete(oldKey);
      const newKey = JSON.stringify([accountId, noteId]);
      this.recoveryDrafts.set(newKey, adopted(memory, noteId));
      if (fenceValue) this.recoveryFences.set(newKey, fenceValue);
    }
    this.notify();
  }
  close() {
    this.closed = true;
    this.lockRequests.abort();
    for (const op of this.clearOps.values()) clearTimeout(op.retry);
    for (const accountId of [...this.accountHolds.keys()])
      this.releaseAccount(accountId);
    this.channel?.close();
    this.db.close();
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Notes written on this device and not yet created on the server: "local-"
 * IDs, and bare UUIDs from earlier offline creation. Server IDs are neither.
 */
function isLocalId(id: string) {
  return id.startsWith("local-") || UUID.test(id);
}
function isRevoked(
  revoked: Set<string>,
  draft: { id: string; source?: string },
) {
  return (
    revoked.has(draft.id) ||
    (draft.source !== undefined && revoked.has(draft.source))
  );
}
/** The same saved snapshot: content and journal, not just the save time. */
function sameSnapshot(draft: Draft | undefined, expected: Draft) {
  return (
    draft !== undefined &&
    draft.updatedAt === expected.updatedAt &&
    draft.document === expected.document &&
    draft.baseRevision === expected.baseRevision &&
    JSON.stringify(draft.steps ?? []) === JSON.stringify(expected.steps ?? [])
  );
}
/**
 * Sync state an editor saving only content does not know: a note created on
 * the server stays created and in its notebook, a recovery keeps its client
 * ID, and a conflict copy keeps its source.
 */
function keepSyncState(written: Draft, previous: Draft | undefined): Draft {
  if (!previous) return written;
  const kept: Partial<Draft> = {};
  if (previous.created && !written.created) kept.created = true;
  if (previous.notebookId && !written.notebookId)
    kept.notebookId = previous.notebookId;
  if (previous.source && !written.source) kept.source = previous.source;
  if (
    previous.clientId &&
    !written.clientId &&
    written.baseRevision === undefined
  )
    kept.clientId = previous.clientId;
  return Object.keys(kept).length ? { ...written, ...kept } : written;
}
function adopted(draft: Draft, noteId: string): Draft {
  const { source: _source, ...rest } = draft;
  return { ...rest, id: noteId, created: true };
}
function summary(body: Draft): Omit<NoteSummary, "kind"> {
  return {
    accountId: body.accountId,
    id: body.id,
    title: body.text.split("\n")[0]?.trim() || "Untitled",
    preview: body.text.split("\n").slice(1).join(" ").slice(0, 160),
    updatedAt: body.updatedAt,
  };
}
export function createNotesStore(name?: string) {
  return new NotesStore(name);
}
