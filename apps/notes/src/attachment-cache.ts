import Dexie, { type Table } from "dexie";

/**
 * Attachment bytes this device has shown, per account (plan 08 B3, after
 * Deltos CONV-0007). An object ID never changes content, so a cached copy
 * stays right for as long as it is kept. Reopening a note shows its pictures
 * without a network request; nothing is fetched ahead of time, and there are
 * no offline downloads (D84).
 *
 * Only the account the app may show right now keeps bytes (`retain`): every
 * other account's are deleted, and an account's bytes go the moment its
 * cache is invalidated (`forget`). App.tsx drives both from the session and
 * the notes cache, so signing out, a revoked session and switching accounts
 * clear them (D28), as does a clear another tab starts. A clear that a
 * closed tab left unfinished completes at the next start, which is signed
 * out or signed in as someone else. Bytes are never read or written for an
 * account that is not retained, and a fetch that finishes after its
 * account's bytes were cleared stores nothing.
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

class AttachmentDatabase extends Dexie {
  /** Sizes and use times only, so eviction never reads any bytes. */
  entries!: Table<Entry, [string, string]>;
  bytes!: Table<Bytes, [string, string]>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      entries: "[accountId+objectId], accountId, usedAt",
      bytes: "[accountId+objectId], accountId",
    });
  }
}

const key = (accountId: string, objectId: string) =>
  accountId + "\u0000" + objectId;

export class AttachmentCache {
  private readonly db: AttachmentDatabase;
  private readonly limit: number;
  /** False once IndexedDB fails: memory only from then on. */
  private persistent = true;
  private retained: string | null = null;
  /** Bumped whenever an account's bytes are cleared; a fetch carries it. */
  private readonly epochs = new Map<string, number>();
  private readonly memory = new Map<string, Blob>();
  private memoryBytes = 0;

  constructor(name = "palladian-attachments", limit = CACHE_LIMIT_BYTES) {
    this.db = new AttachmentDatabase(name);
    this.limit = limit;
  }

  /**
   * The account whose bytes may be kept and read: the account the app shows,
   * or null while it shows none. Every other account's bytes are deleted.
   */
  retain(accountId: string | null): Promise<void> {
    if (accountId !== this.retained) {
      for (const other of new Set([...this.epochs.keys(), this.retained]))
        if (other !== null && other !== accountId) this.bump(other);
      this.retained = accountId;
    }
    this.dropMemory((entry) => entry !== accountId);
    return this.run(async () => {
      if (accountId === null) {
        await this.db.entries.clear();
        await this.db.bytes.clear();
        return;
      }
      await this.db.entries.where("accountId").notEqual(accountId).delete();
      await this.db.bytes.where("accountId").notEqual(accountId).delete();
    });
  }

  /** Delete one account's bytes now (sign-out, revocation, invalidation). */
  forget(accountId: string): Promise<void> {
    this.bump(accountId);
    this.dropMemory((entry) => entry === accountId);
    return this.run(async () => {
      await this.db.entries.where("accountId").equals(accountId).delete();
      await this.db.bytes.where("accountId").equals(accountId).delete();
    });
  }

  /** Delete one object's bytes, for example once it is known to be gone. */
  drop(accountId: string, objectId: string): Promise<void> {
    const id = key(accountId, objectId);
    const blob = this.memory.get(id);
    if (blob) {
      this.memory.delete(id);
      this.memoryBytes -= blob.size;
    }
    return this.run(async () => {
      await this.db.entries.delete([accountId, objectId]);
      await this.db.bytes.delete([accountId, objectId]);
    });
  }

  /**
   * A mark to pass to `store` when a fetch starts: bytes fetched for an
   * account whose bytes were cleared meanwhile are not stored.
   */
  mark(accountId: string): number {
    return this.epochs.get(accountId) ?? 0;
  }

  /** The cached bytes, or null. Only the retained account has any. */
  async read(accountId: string, objectId: string): Promise<Blob | null> {
    if (accountId !== this.retained) return null;
    const id = key(accountId, objectId);
    const remembered = this.memory.get(id);
    if (remembered) {
      this.remember(id, remembered);
      void this.touch(accountId, objectId);
      return remembered;
    }
    const epoch = this.mark(accountId);
    const row = await this.run(() =>
      this.db.bytes.get([accountId, objectId]),
    ).catch(() => undefined);
    if (!row || !this.current(accountId, epoch)) return null;
    this.remember(id, row.blob);
    void this.touch(accountId, objectId);
    return row.blob;
  }

  /**
   * Keep bytes for the retained account, unless its bytes were cleared since
   * `epoch` (from `mark` when the fetch started). Then trim to the cap.
   */
  async store(
    accountId: string,
    objectId: string,
    blob: Blob,
    epoch = this.mark(accountId),
  ): Promise<void> {
    if (!this.current(accountId, epoch) || blob.size > ENTRY_LIMIT_BYTES)
      return;
    this.remember(key(accountId, objectId), blob);
    if (!this.persistent) return;
    await this.run(async () => {
      // Checked again where the write starts: a clear queued earlier has
      // run, and one queued later runs after this write.
      if (!this.current(accountId, epoch)) return;
      await this.db.transaction(
        "rw",
        [this.db.entries, this.db.bytes],
        async () => {
          await this.db.bytes.put({ accountId, objectId, blob });
          await this.db.entries.put({
            accountId,
            objectId,
            size: blob.size,
            usedAt: Date.now(),
          });
        },
      );
      await this.evict();
    }).catch(() => undefined);
    // A clear that began while the write was under way removes it again.
    if (!this.current(accountId, epoch))
      await this.drop(accountId, objectId).catch(() => undefined);
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
    this.db.close();
  }

  private current(accountId: string, epoch: number) {
    return accountId === this.retained && this.mark(accountId) === epoch;
  }

  private bump(accountId: string) {
    this.epochs.set(accountId, this.mark(accountId) + 1);
  }

  /** IndexedDB work, unless it has failed; then the cache is memory only. */
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

  private remember(id: string, blob: Blob) {
    const previous = this.memory.get(id);
    if (previous) {
      this.memory.delete(id);
      this.memoryBytes -= previous.size;
    }
    if (blob.size > MEMORY_LIMIT_BYTES) return;
    this.memory.set(id, blob);
    this.memoryBytes += blob.size;
    for (const [oldest, value] of this.memory) {
      if (this.memoryBytes <= MEMORY_LIMIT_BYTES) break;
      this.memory.delete(oldest);
      this.memoryBytes -= value.size;
    }
  }

  private dropMemory(matches: (accountId: string) => boolean) {
    for (const [id, blob] of this.memory)
      if (matches(id.slice(0, id.indexOf("\u0000")))) {
        this.memory.delete(id);
        this.memoryBytes -= blob.size;
      }
  }
}

/** The app's attachment cache. */
export const attachmentCache = new AttachmentCache();
