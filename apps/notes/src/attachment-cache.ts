import Dexie, { type Table } from "dexie";

/**
 * Attachment bytes this device has shown, per account (plan 08 B3, after
 * Deltos CONV-0007). An object ID never changes content, so a cached copy
 * stays right for as long as it is kept. Reopening a note shows its pictures
 * without a network request; nothing is fetched ahead of time, and there are
 * no offline downloads (D84).
 *
 * Only the account the app shows right now (`retain`) may read or store
 * bytes. Leaving an account clears its bytes, as does `forget`
 * (attachment-cache-lifecycle.ts drives both from the session and the
 * shared account hint on every page; D28).
 *
 * Clears fail closed (review round 1, F2):
 * - Each account has a persisted lifecycle. A clear first records a later
 *   lifecycle marked unfinished, then deletes the account's bytes and their
 *   sizes in one transaction and clears the mark. A clear that never
 *   finishes leaves the mark, and no tab reads the account's bytes while it
 *   is there: the next read, or the next start, finishes it first.
 * - A failed clear stays pending and is retried while the page lives.
 * - Bytes are written only into the lifecycle the fetch began in, checked
 *   in the writing transaction, so a write from a tab that has not heard of
 *   a clear yet stores nothing.
 *
 * Least recently used bytes go first once the total passes the cap. If
 * IndexedDB is unavailable the cache works in memory only.
 */

/** Largest total of cached bytes on this device: Deltos's budget. */
export const CACHE_LIMIT_BYTES = 200 * 1024 * 1024;
/** Uploads are at most 25 MB, so every object fits. */
export const ENTRY_LIMIT_BYTES = 25 * 1024 * 1024;
/** Bytes also kept in memory for this page, so a redrawn picture never waits. */
const MEMORY_LIMIT_BYTES = 48 * 1024 * 1024;
/** Waits before retrying a failed clear. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface Entry {
  accountId: string;
  objectId: string;
  size: number;
  /** When the bytes were last stored or shown: the eviction order. */
  usedAt: number;
}
interface Bytes {
  accountId: string;
  objectId: string;
  blob: Blob;
}
/** How many times an account's bytes were cleared, and whether a clear is unfinished. */
interface AccountRow {
  accountId: string;
  lifecycle: number;
  clearing: boolean;
}

class AttachmentDatabase extends Dexie {
  /** Sizes and use times only, so eviction never reads any bytes. */
  entries!: Table<Entry, [string, string]>;
  bytes!: Table<Bytes, [string, string]>;
  accounts!: Table<AccountRow, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      entries: "[accountId+objectId], accountId, usedAt",
      bytes: "[accountId+objectId], accountId",
      accounts: "accountId",
    });
  }
}

/**
 * What a fetch carries from its start: its bytes are stored only if the
 * account's bytes were not cleared since, in this tab or any other.
 */
export interface CacheTicket {
  accountId: string;
  /** This tab's clears of the account. */
  local: number;
  /** The account's persisted lifecycle; -1 when the cache is memory only. */
  lifecycle: number;
}

const key = (accountId: string, objectId: string) =>
  accountId + "\u0000" + objectId;

export class AttachmentCache {
  private readonly db: AttachmentDatabase;
  private readonly limit: number;
  /** False once IndexedDB fails to open: memory only from then on. */
  private persistent = true;
  private closed = false;
  private active: string | null = null;
  /** Clears asked for in this tab and not finished: reads and writes refused. */
  private readonly pending = new Map<string, number>();
  /** This tab's clears per account, so a fetch can tell one happened. */
  private readonly local = new Map<string, number>();
  /** Each account's persisted lifecycle, as this tab last read it. */
  private readonly lifecycles = new Map<string, number>();
  private readonly memory = new Map<
    string,
    { blob: Blob; lifecycle: number }
  >();
  private memoryBytes = 0;
  /** Clears and sweeps run one after another, in the order asked. */
  private queue: Promise<unknown> = Promise.resolve();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(name = "palladian-attachments", limit = CACHE_LIMIT_BYTES) {
    this.db = new AttachmentDatabase(name);
    this.limit = limit;
  }

  /**
   * The account whose bytes may be kept and read: the account the app
   * shows, or null while it shows none. The account shown before is
   * cleared, and so is every other account's bytes still on the device.
   */
  retain(accountId: string | null): Promise<void> {
    const previous = this.active;
    this.active = accountId;
    this.dropMemory((owner) => owner !== accountId);
    const left =
      previous !== null && previous !== accountId
        ? this.forget(previous)
        : Promise.resolve();
    const swept = this.enqueue(() => this.sweep());
    return Promise.all([left, swept]).then(() => undefined);
  }

  /** Clear one account's bytes (sign-out, revocation, invalidation). */
  forget(accountId: string): Promise<void> {
    this.bump(accountId);
    const request = (this.pending.get(accountId) ?? 0) + 1;
    this.pending.set(accountId, request);
    return this.enqueue(() => this.clear(accountId, true)).then(() => {
      if (this.pending.get(accountId) === request)
        this.pending.delete(accountId);
    });
  }

  /** Delete one object's bytes, for example once it is known to be gone. */
  async drop(accountId: string, objectId: string): Promise<void> {
    this.forgetMemory(key(accountId, objectId));
    if (!this.persistent) return;
    await this.run(() =>
      this.db.transaction("rw", [this.db.entries, this.db.bytes], async () => {
        await this.db.entries.delete([accountId, objectId]);
        await this.db.bytes.delete([accountId, objectId]);
      }),
    );
  }

  /**
   * Taken when a fetch starts, and passed to `store` with its bytes. Null
   * when the account may not keep bytes now.
   */
  async ticket(accountId: string): Promise<CacheTicket | null> {
    if (!(await this.ready(accountId))) return null;
    const local = this.local.get(accountId) ?? 0;
    if (!this.persistent) return { accountId, local, lifecycle: -1 };
    const row = await this.run(() => this.db.accounts.get(accountId)).catch(
      () => null,
    );
    if (row === null || !this.usable(accountId)) return null;
    if (row?.clearing) {
      void this.finishLater(accountId);
      return null;
    }
    const lifecycle = row?.lifecycle ?? 0;
    this.lifecycles.set(accountId, lifecycle);
    return { accountId, local, lifecycle };
  }

  /**
   * The cached bytes, or null. Only the retained account has any, and none
   * while a clear of it is unfinished, here or in another tab.
   */
  async read(accountId: string, objectId: string): Promise<Blob | null> {
    if (!(await this.ready(accountId))) return null;
    const id = key(accountId, objectId);
    const remembered = this.memory.get(id);
    if (!this.persistent) return remembered?.blob ?? null;
    let found: { row: AccountRow | undefined; stored: Bytes | undefined };
    try {
      found = await this.run(() =>
        this.db.transaction(
          "r",
          [this.db.accounts, this.db.bytes],
          async () => ({
            row: await this.db.accounts.get(accountId),
            stored: remembered
              ? undefined
              : await this.db.bytes.get([accountId, objectId]),
          }),
        ),
      );
    } catch {
      return null;
    }
    if (!this.usable(accountId)) return null;
    if (found.row?.clearing) {
      void this.finishLater(accountId);
      return null;
    }
    const lifecycle = found.row?.lifecycle ?? 0;
    this.lifecycles.set(accountId, lifecycle);
    if (remembered && remembered.lifecycle !== lifecycle) {
      // Kept from a lifecycle that has ended since.
      this.forgetMemory(id);
      return null;
    }
    const blob = remembered?.blob ?? found.stored?.blob ?? null;
    if (!blob) return null;
    this.remember(id, blob, lifecycle);
    void this.touch(accountId, objectId);
    return blob;
  }

  /**
   * Keep bytes fetched under `ticket` (by default, the account as this tab
   * knows it now), unless the account's bytes were cleared since, in this
   * tab or another. Then trim to the cap.
   */
  async store(
    accountId: string,
    objectId: string,
    blob: Blob,
    ticket: CacheTicket | null = this.currentTicket(accountId),
  ): Promise<void> {
    if (
      !ticket ||
      ticket.accountId !== accountId ||
      blob.size > ENTRY_LIMIT_BYTES ||
      !this.valid(ticket)
    )
      return;
    const id = key(accountId, objectId);
    if (!this.persistent) {
      this.remember(id, blob, ticket.lifecycle);
      return;
    }
    let stored = false;
    try {
      stored = await this.run(() =>
        this.db.transaction(
          "rw",
          [this.db.accounts, this.db.entries, this.db.bytes],
          async () => {
            // Checked where the write happens: a clear that began since the
            // fetch did, in any tab, ended its lifecycle.
            const row = await this.db.accounts.get(accountId);
            if (row?.clearing || (row?.lifecycle ?? 0) !== ticket.lifecycle)
              return false;
            await this.db.bytes.put({ accountId, objectId, blob });
            await this.db.entries.put({
              accountId,
              objectId,
              size: blob.size,
              usedAt: Date.now(),
            });
            return true;
          },
        ),
      );
    } catch {
      return;
    }
    if (!stored) return;
    if (this.valid(ticket)) this.remember(id, blob, ticket.lifecycle);
    await this.run(() => this.evict()).catch(() => undefined);
  }

  /** Resolves once the clears asked for so far have run (for tests). */
  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  /** The total size kept in IndexedDB (for tests and diagnostics). */
  async size(): Promise<number> {
    const entries = await this.run(() => this.db.entries.toArray());
    return entries.reduce((total, entry) => total + entry.size, 0);
  }

  /** Object IDs kept for an account, least recently used first (for tests). */
  async objects(accountId: string): Promise<string[]> {
    const entries = await this.run(() =>
      this.db.entries.orderBy("usedAt").toArray(),
    );
    return entries
      .filter((entry) => entry.accountId === accountId)
      .map((entry) => entry.objectId);
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.db.close();
  }

  /** May this account read and write now (synchronous part). */
  private usable(accountId: string) {
    return accountId === this.active && !this.pending.has(accountId);
  }

  /** Usable once every clear asked for before has run. */
  private async ready(accountId: string) {
    if (!this.usable(accountId)) return false;
    await this.settled();
    return this.usable(accountId);
  }

  private valid(ticket: CacheTicket) {
    return (
      this.usable(ticket.accountId) &&
      (this.local.get(ticket.accountId) ?? 0) === ticket.local
    );
  }

  private currentTicket(accountId: string): CacheTicket | null {
    if (!this.usable(accountId)) return null;
    const lifecycle = this.persistent ? this.lifecycles.get(accountId) : -1;
    if (lifecycle === undefined) return null;
    return { accountId, local: this.local.get(accountId) ?? 0, lifecycle };
  }

  private bump(accountId: string) {
    this.local.set(accountId, (this.local.get(accountId) ?? 0) + 1);
    this.dropMemory((owner) => owner === accountId);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => {
        this.attempts = 0;
      },
      () => this.retryLater(),
    );
    return run;
  }

  /** A failed clear stays pending and is tried again, with growing waits. */
  private retryLater() {
    if (this.closed || this.retry) return;
    const wait = RETRY_MS[Math.min(this.attempts++, RETRY_MS.length - 1)]!;
    this.retry = setTimeout(() => {
      this.retry = null;
      for (const [accountId, request] of this.pending)
        void this.enqueue(() => this.clear(accountId, true)).then(() => {
          if (this.pending.get(accountId) === request)
            this.pending.delete(accountId);
        });
      void this.enqueue(() => this.sweep());
    }, wait);
  }

  /**
   * End an account's lifecycle: record the next one as unfinished, then
   * delete its bytes and sizes and the mark in one transaction. `advance`
   * false finishes a clear recorded earlier without starting another.
   */
  private async clear(accountId: string, advance: boolean) {
    await this.durable(async () => {
      const marked = await this.db.transaction(
        "rw",
        this.db.accounts,
        async () => {
          const row = await this.db.accounts.get(accountId);
          // Finished meanwhile (another tab): nothing left to do.
          if (!advance && !row?.clearing) return false;
          await this.db.accounts.put({
            accountId,
            lifecycle: (row?.lifecycle ?? 0) + (advance ? 1 : 0),
            clearing: true,
          });
          return true;
        },
      );
      if (marked) await this.finish(accountId);
    });
  }

  /** Delete an account's bytes and sizes, and its unfinished mark, at once. */
  private async finish(accountId: string) {
    await this.db.transaction(
      "rw",
      [this.db.accounts, this.db.entries, this.db.bytes],
      async () => {
        await this.db.entries.where("accountId").equals(accountId).delete();
        await this.db.bytes.where("accountId").equals(accountId).delete();
        const row = await this.db.accounts.get(accountId);
        if (row?.clearing)
          await this.db.accounts.put({ ...row, clearing: false });
      },
    );
  }

  /** An unfinished clear found while reading: finish it before any read. */
  private finishLater(accountId: string): Promise<void> {
    if (this.pending.has(accountId)) return this.settled();
    this.bump(accountId);
    this.pending.set(accountId, 1);
    return this.enqueue(() => this.clear(accountId, false)).then(() => {
      if (this.pending.get(accountId) === 1) this.pending.delete(accountId);
    });
  }

  /**
   * Clear every account's bytes but the retained one's, and finish any
   * unfinished clear, the retained account's included. Each is marked
   * before anything is deleted.
   */
  private async sweep() {
    const keep = this.active;
    await this.durable(async () => {
      const stale = await this.db.transaction(
        "rw",
        [this.db.accounts, this.db.entries, this.db.bytes],
        async () => {
          const owners = new Set<string>();
          for (const owner of [
            ...(await this.db.entries.orderBy("accountId").uniqueKeys()),
            ...(await this.db.bytes.orderBy("accountId").uniqueKeys()),
          ])
            owners.add(String(owner));
          const rows = await this.db.accounts.toArray();
          for (const row of rows) if (row.clearing) owners.add(row.accountId);
          const marked: string[] = [];
          for (const owner of owners) {
            const row = rows.find((candidate) => candidate.accountId === owner);
            if (owner === keep && !row?.clearing) continue;
            if (!row?.clearing)
              await this.db.accounts.put({
                accountId: owner,
                lifecycle: (row?.lifecycle ?? 0) + 1,
                clearing: true,
              });
            marked.push(owner);
          }
          return marked;
        },
      );
      for (const owner of stale) await this.finish(owner);
      if (keep !== null) {
        const row = await this.db.accounts.get(keep);
        this.lifecycles.set(keep, row?.lifecycle ?? 0);
      }
    });
  }

  /**
   * A clear's IndexedDB work. Without a usable database there is nothing
   * stored to clear (nothing can be read from it either): done.
   */
  private async durable(work: () => Promise<void>) {
    if (!this.persistent) return;
    try {
      await this.run(work);
    } catch (error) {
      if (this.persistent) throw error;
    }
  }

  /** IndexedDB work; if the database cannot open, the cache is memory only. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.persistent) throw new Error("Attachment cache is memory only.");
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Dexie.OpenFailedError ||
        error instanceof Dexie.MissingAPIError ||
        error instanceof Dexie.DatabaseClosedError
      )
        this.persistent = false;
      throw error;
    }
  }

  private async touch(accountId: string, objectId: string) {
    try {
      await this.run(() =>
        this.db.entries.update([accountId, objectId], { usedAt: Date.now() }),
      );
    } catch {
      // Recency only; the bytes are still right.
    }
  }

  /** Delete the least recently used bytes until the total is within the cap. */
  private async evict() {
    await this.db.transaction(
      "rw",
      [this.db.entries, this.db.bytes],
      async () => {
        const entries = await this.db.entries.orderBy("usedAt").toArray();
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) {
          if (total <= this.limit) break;
          await this.db.entries.delete([entry.accountId, entry.objectId]);
          await this.db.bytes.delete([entry.accountId, entry.objectId]);
          total -= entry.size;
        }
      },
    );
  }

  private remember(id: string, blob: Blob, lifecycle: number) {
    this.forgetMemory(id);
    if (blob.size > MEMORY_LIMIT_BYTES) return;
    this.memory.set(id, { blob, lifecycle });
    this.memoryBytes += blob.size;
    for (const [oldest, value] of this.memory) {
      if (this.memoryBytes <= MEMORY_LIMIT_BYTES) break;
      this.memory.delete(oldest);
      this.memoryBytes -= value.blob.size;
    }
  }

  private forgetMemory(id: string) {
    const previous = this.memory.get(id);
    if (!previous) return;
    this.memory.delete(id);
    this.memoryBytes -= previous.blob.size;
  }

  private dropMemory(matches: (accountId: string) => boolean) {
    for (const id of [...this.memory.keys()])
      if (matches(id.slice(0, id.indexOf("\u0000")))) this.forgetMemory(id);
  }
}

/** The app's attachment cache. */
export const attachmentCache = new AttachmentCache();
