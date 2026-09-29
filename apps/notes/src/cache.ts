import Dexie, { type Table } from "dexie";

export interface NoteSummary {
  accountId: string;
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  kind: "cached" | "draft";
}
export interface NoteBody {
  accountId: string;
  id: string;
  document: string;
  text: string;
}
export interface Draft extends NoteBody {
  updatedAt: number;
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
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      summaries: "[accountId+id], accountId",
      bodies: "[accountId+id], accountId",
      drafts: "[accountId+id], accountId",
      accounts: "accountId",
      privacy: "key",
    });
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
          "accountId" in value &&
          typeof value.accountId === "string"
        ) {
          this.activationEpoch++;
          this.blocked.add(value.accountId);
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
    const after = await this.db.accounts.get(accountId);
    return this.epoch(accountId) === epoch &&
      !this.blocked.has(accountId) &&
      !after?.blocked &&
      (after?.epoch ?? 0) === (persisted?.epoch ?? 0)
      ? rows.sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  }
  async read(accountId: string, id: string): Promise<NoteBody | undefined> {
    if (this.blocked.has(accountId)) return undefined;
    const epoch = this.epoch(accountId);
    const persisted = await this.db.accounts.get(accountId);
    if (persisted?.blocked) return undefined;
    const draft = await this.db.drafts.get([accountId, id]);
    const body = draft ?? (await this.db.bodies.get([accountId, id]));
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
    const fence = this.captureFence(draft.accountId);
    const key = JSON.stringify([draft.accountId, draft.id]);
    const previous = this.draftQueues.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const captured = await fence;
        this.assertWritable(draft.accountId, epoch);
        await this.db.transaction(
          "rw",
          this.db.drafts,
          this.db.summaries,
          this.db.accounts,
          async () => {
            await this.assertPersistent(draft.accountId, captured.epoch);
            this.assertWritable(draft.accountId, epoch);
            await this.db.drafts.put(draft);
            await this.db.summaries.put({ ...summary(draft), kind: "draft" });
          },
        );
        this.notify();
      });
    // Observe fence rejection immediately even if an older write is queued.
    void fence.catch(() => undefined);
    this.draftQueues.set(key, write);
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
      this.db.bodies,
      this.db.summaries,
      this.db.drafts,
      this.db.accounts,
      async () => {
        await this.assertPersistent(body.accountId, fence.epoch);
        this.assertWritable(body.accountId, epoch);
        await this.db.bodies.put(body);
        // Accepted refresh must not overwrite unsaved local recovery content.
        if (!(await this.db.drafts.get([body.accountId, body.id]))) {
          await this.db.summaries.put({
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
    this.epochs.set(accountId, this.epoch(accountId) + 1);
    this.notify({ accountId, invalidated: true });
    this.channel?.postMessage({ accountId });
    await this.db.transaction(
      "rw",
      this.db.summaries,
      this.db.bodies,
      this.db.drafts,
      this.db.accounts,
      this.db.privacy,
      async () => {
        const privacy = await this.db.privacy.get("activation");
        await this.db.privacy.put({
          key: "activation",
          epoch: (privacy?.epoch ?? 0) + 1,
        });
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
    return (
      (await this.db.drafts.where("accountId").equals(accountId).count()) > 0
    );
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
          epoch: (account?.epoch ?? 0) + 1,
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
