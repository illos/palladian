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
}

class NotesDatabase extends Dexie {
  summaries!: Table<NoteSummary, [string, string]>;
  bodies!: Table<NoteBody, [string, string]>;
  drafts!: Table<Draft, [string, string]>;
  accounts!: Table<
    { accountId: string; epoch: number; blocked: boolean },
    string
  >;
  privacy!: Table<{ key: string; epoch: number }, string>;
  notebooks!: Table<CachedNotebook, [string, string]>;
  cursors!: Table<
    { accountId: string; key: string; value: number },
    [string, string]
  >;
  revoked!: Table<
    { accountId: string; id: string; at: number },
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
  private readonly recoveryDrafts = new Map<string, Draft>();
  private readonly recoveryFences = new Map<string, Promise<CacheFence>>();
  constructor(name = "palladian-notes-foundation") {
    this.db = new NotesDatabase(name);
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
          this.forgetNotes(value.accountId, ids);
          this.notify({ accountId: value.accountId, revokedNotes: ids });
          return;
        }
        if (
          typeof value === "object" &&
          value !== null &&
          "accountId" in value &&
          typeof value.accountId === "string"
        ) {
          this.activationEpoch++;
          this.blocked.add(value.accountId);
          this.forgetRecovery(value.accountId);
          this.epochs.set(value.accountId, this.epoch(value.accountId) + 1);
          this.notify({ accountId: value.accountId, invalidated: true });
        }
      };
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
    // This reads only summaries, never all document bodies.
    const rows = await this.db.summaries
      .where("accountId")
      .equals(accountId)
      .toArray();
    const visible = new Map(rows.map((row) => [row.id, row]));
    for (const draft of await this.accessibleRecovery(
      accountId,
      persisted?.epoch ?? 0,
    ))
      visible.set(draft.id, {
        ...visible.get(draft.id),
        ...summary(draft),
        kind: "draft",
      });
    const after = await this.db.accounts.get(accountId);
    return this.epoch(accountId) === epoch &&
      !this.blocked.has(accountId) &&
      !after?.blocked &&
      (after?.epoch ?? 0) === (persisted?.epoch ?? 0)
      ? [...visible.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  }
  async read(accountId: string, id: string): Promise<NoteBody | undefined> {
    if (this.blocked.has(accountId)) return undefined;
    const epoch = this.epoch(accountId);
    const persisted = await this.db.accounts.get(accountId);
    if (persisted?.blocked) return undefined;
    const draft = await this.db.drafts.get([accountId, id]);
    const recovered = (
      await this.accessibleRecovery(accountId, persisted?.epoch ?? 0)
    ).find((value) => value.id === id);
    const body =
      recovered ?? draft ?? (await this.db.bodies.get([accountId, id]));
    const after = await this.db.accounts.get(accountId);
    return this.epoch(accountId) === epoch &&
      !this.blocked.has(accountId) &&
      !after?.blocked &&
      (after?.epoch ?? 0) === (persisted?.epoch ?? 0)
      ? body
      : undefined;
  }
  writeDraft(draft: Draft): Promise<void> {
    const epoch = this.epoch(draft.accountId);
    if (this.blocked.has(draft.accountId))
      return Promise.reject(new Error("Account access changed"));
    const fence = this.captureFence(draft.accountId);
    const key = JSON.stringify([draft.accountId, draft.id]);
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
            await this.db.drafts.put(draft);
            const previous = await this.db.summaries.get([
              draft.accountId,
              draft.id,
            ]);
            await this.db.summaries.put({
              ...previous,
              ...(draft.notebookId ? { notebookId: draft.notebookId } : {}),
              ...summary(draft),
              kind: "draft",
            });
          },
        );
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
  async clearAccount(accountId: string): Promise<void> {
    this.activationEpoch++;
    this.blocked.add(accountId);
    this.forgetRecovery(accountId);
    this.epochs.set(accountId, this.epoch(accountId) + 1);
    this.notify({ accountId, invalidated: true });
    this.channel?.postMessage({ accountId });
    await this.db.transaction(
      "rw",
      [
        this.db.summaries,
        this.db.bodies,
        this.db.drafts,
        this.db.accounts,
        this.db.privacy,
        this.db.notebooks,
        this.db.cursors,
        this.db.revoked,
      ],
      async () => {
        const privacy = await this.db.privacy.get("activation");
        await this.db.privacy.put({
          key: "activation",
          epoch: (privacy?.epoch ?? 0) + 1,
        });
        await this.db.notebooks.where("accountId").equals(accountId).delete();
        await this.db.cursors.where("accountId").equals(accountId).delete();
        await this.db.revoked.where("accountId").equals(accountId).delete();
        const account = await this.db.accounts.get(accountId);
        await this.db.accounts.put({
          accountId,
          epoch: (account?.epoch ?? 0) + 1,
          blocked: true,
        });
        await this.db.summaries.where("accountId").equals(accountId).delete();
        await this.db.bodies.where("accountId").equals(accountId).delete();
        await this.db.drafts.where("accountId").equals(accountId).delete();
      },
    );
    this.notify();
  }
  async hasDrafts(accountId: string) {
    if (
      [...this.recoveryDrafts.values()].some(
        (draft) => draft.accountId === accountId,
      )
    )
      return true;
    return (
      (await this.db.drafts.where("accountId").equals(accountId).count()) > 0
    );
  }
  async exportDrafts(accountId: string): Promise<Draft[]> {
    const epoch = this.epoch(accountId);
    const fence = await this.captureFence(accountId);
    await Promise.allSettled([...this.draftQueues.values()]);
    const drafts = await this.db.drafts
      .where("accountId")
      .equals(accountId)
      .toArray();
    await this.assertPersistent(accountId, fence.epoch);
    this.assertWritable(accountId, epoch);
    const revoked = await this.revokedIds(accountId);
    // Work on notes this account lost access to is never exportable.
    const latest = new Map(
      drafts
        .filter((draft) => !revoked.has(draft.id))
        .map((draft) => [draft.id, draft]),
    );
    for (const draft of await this.accessibleRecovery(accountId, fence.epoch))
      latest.set(draft.id, { ...draft });
    await this.assertPersistent(accountId, fence.epoch);
    this.assertWritable(accountId, epoch);
    return [...latest.values()];
  }
  private forgetRecovery(accountId: string) {
    for (const [key, draft] of this.recoveryDrafts)
      if (draft.accountId === accountId) {
        this.recoveryDrafts.delete(key);
        this.recoveryFences.delete(key);
      }
  }
  private async accessibleRecovery(
    accountId: string,
    epoch: number,
  ): Promise<Draft[]> {
    const drafts: Draft[] = [];
    const revoked = await this.revokedIds(accountId);
    for (const [key, draft] of this.recoveryDrafts) {
      if (draft.accountId !== accountId || revoked.has(draft.id)) continue;
      const fence = await this.recoveryFences.get(key)?.catch(() => null);
      if (
        fence?.epoch === epoch &&
        !this.blocked.has(accountId) &&
        this.recoveryDrafts.get(key) === draft
      )
        drafts.push({ ...draft });
    }
    return drafts;
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
    await this.db.transaction(
      "rw",
      this.db.accounts,
      this.db.privacy,
      async () => {
        const privacy = await this.db.privacy.get("activation");
        const account = await this.db.accounts.get(accountId);
        assertCurrent();
        if ((privacy?.epoch ?? 0) !== fence.epoch)
          throw new Error("Session activation was invalidated.");
        await this.db.accounts.put({
          accountId,
          epoch: (account?.epoch ?? 0) + (account?.blocked ? 1 : 0),
          blocked: false,
        });
      },
    );
    assertCurrent();
    this.blocked.delete(accountId);
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
        await this.fenceNotes(accountId, removed);
        if (cursor)
          await this.db.cursors.put({
            accountId,
            key: cursor.key,
            value: cursor.value,
          });
      },
    );
    this.announceRevoked(accountId, removed);
    this.notify();
    return fenced;
  }
  /**
   * Lift fences for notes the server confirmed accessible by a request issued
   * at `checkedAt`; a fence recorded later than that request stays.
   */
  async allowNotes(
    accountId: string,
    ids: string[],
    checkedAt: number,
  ): Promise<void> {
    await this.db.transaction("rw", [this.db.revoked], async () => {
      for (const id of ids) {
        const marker = await this.db.revoked.get([accountId, id]);
        if (marker && marker.at < checkedAt)
          await this.db.revoked.delete([accountId, id]);
      }
    });
  }
  /** Delete a note's local copies and record a persistent fence. Inside a transaction. */
  private async fenceNotes(accountId: string, ids: string[]) {
    const at = Date.now();
    for (const id of ids) {
      await this.db.summaries.delete([accountId, id]);
      await this.db.bodies.delete([accountId, id]);
      await this.db.drafts.delete([accountId, id]);
      await this.db.revoked.put({ accountId, id, at });
    }
  }
  private announceRevoked(accountId: string, ids: string[]) {
    if (!ids.length) return;
    this.forgetNotes(accountId, ids);
    this.channel?.postMessage({ accountId, revokedNotes: ids });
    this.notify({ accountId, revokedNotes: ids });
  }
  private forgetNotes(accountId: string, ids: string[]) {
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
        await this.fenceNotes(accountId, ids);
      },
    );
    this.announceRevoked(accountId, ids);
    this.notify();
  }
  /**
   * Reconcile cached server notes against one complete authorization snapshot:
   * a note survives if its notebook is visible or it is shared individually.
   * Local notes never sent to the server carry no role and are kept.
   */
  async reconcileAccess(
    accountId: string,
    visibleNotebooks: Set<string>,
    sharedNotes: Set<string>,
    fence: CacheFence,
  ): Promise<string[]> {
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
        this.db.cursors,
      ],
      async () => {
        await this.assertPersistent(accountId, fence.epoch);
        this.assertWritable(accountId, epoch);
        const rows = await this.db.summaries
          .where("accountId")
          .equals(accountId)
          .toArray();
        revoked = rows
          .filter(
            (row) =>
              row.role !== undefined &&
              !sharedNotes.has(row.id) &&
              !(row.notebookId && visibleNotebooks.has(row.notebookId)),
          )
          .map((row) => row.id);
        await this.fenceNotes(accountId, revoked);
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
    this.announceRevoked(accountId, revoked);
    if (revoked.length) this.notify();
    return revoked;
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
    return (
      this.recoveryDrafts.get(key) ??
      (await this.db.drafts.get([accountId, id]))
    );
  }
  async localDrafts(accountId: string): Promise<Draft[]> {
    if (this.blocked.has(accountId)) return [];
    const rows = await this.db.drafts
      .where("accountId")
      .equals(accountId)
      .toArray();
    return rows.filter(
      (draft) => draft.baseRevision === undefined && draft.created !== true,
    );
  }
  /** Drafts created on the server whose content has not been reconciled yet. */
  async adoptedDrafts(accountId: string): Promise<Draft[]> {
    if (this.blocked.has(accountId)) return [];
    const rows = await this.db.drafts
      .where("accountId")
      .equals(accountId)
      .toArray();
    return rows.filter(
      (draft) => draft.baseRevision === undefined && draft.created === true,
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
        if (expected && current && current.updatedAt !== expected.updatedAt)
          return;
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
    if (memory && (!expected || memory.updatedAt === expected.updatedAt)) {
      this.recoveryDrafts.delete(key);
      this.recoveryFences.delete(key);
    }
    this.notify();
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
        if (draft)
          await this.db.drafts.put({ ...draft, id: noteId, created: true });
        if (row) await this.db.summaries.put({ ...row, id: noteId });
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
      this.recoveryDrafts.set(newKey, { ...memory, id: noteId, created: true });
      if (fenceValue) this.recoveryFences.set(newKey, fenceValue);
    }
    this.notify();
  }
  close() {
    this.channel?.close();
    this.db.close();
  }
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
