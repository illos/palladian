import { fileWritesEnabled, onFileWritesChange } from "./file-capability";

/**
 * Attachment bytes this page has shown, in memory only (plan 08 B3; review
 * round 3). Nothing is written to IndexedDB, localStorage or anywhere else
 * that outlives the page, so nothing needs clearing at sign-out beyond
 * this page's memory, and a reload starts empty. A persistent cache needs
 * the notes cache's own account lifecycle and waits for the owner (see the
 * implementation report).
 *
 * The bytes belong to one account and session generation (a scope). Any
 * change of scope, the session ending, and files turning off clear them
 * at once, before anything can read again: bytes are read and stored only
 * under a ticket for the current scope, and every clear ends every ticket.
 * So the same page going from Ada to Bob and back to Ada never sees Ada's
 * earlier bytes.
 *
 * Least recently used bytes go first once the total passes the cap.
 */

/** Largest total of bytes kept in memory. */
export const CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
/** Uploads are at most 25 MB, so every object fits. */
export const ENTRY_LIMIT_BYTES = 25 * 1024 * 1024;

/** Whose bytes these are: an account, in one session generation. */
export interface CacheScope {
  accountId: string;
  generation: number;
}

/** Taken when a read starts; it reads and stores only while still current. */
export interface CacheTicket {
  scope: CacheScope;
  epoch: number;
}

const same = (a: CacheScope | null, b: CacheScope | null) =>
  a === b ||
  (!!a && !!b && a.accountId === b.accountId && a.generation === b.generation);

export class AttachmentCache {
  private readonly limit: number;
  private scope: CacheScope | null = null;
  /** Bumped by every clear: tickets from before it are void. */
  private epoch = 0;
  /** Bytes by object, least recently used first. */
  private readonly entries = new Map<string, Blob>();
  private total = 0;

  constructor(limit = CACHE_LIMIT_BYTES) {
    this.limit = limit;
  }

  /**
   * The scope whose bytes may be kept: the signed-in account and session
   * generation the app shows, or null. Any change clears every byte.
   */
  follow(scope: CacheScope | null) {
    if (same(scope, this.scope)) return;
    this.clear();
    this.scope = scope ? { ...scope } : null;
  }

  /** Forget every byte; tickets taken before stop working. */
  clear() {
    this.entries.clear();
    this.total = 0;
    this.epoch++;
  }

  /** A ticket for `scope` if it is the current one and files are on. */
  ticket(scope: CacheScope): CacheTicket | null {
    if (!fileWritesEnabled() || !this.scope || !same(scope, this.scope))
      return null;
    return { scope: this.scope, epoch: this.epoch };
  }

  /** A ticket for the current scope, if there is one and files are on. */
  current(): CacheTicket | null {
    return this.scope ? this.ticket(this.scope) : null;
  }

  /** The cached bytes, or null; only under a current ticket. */
  read(ticket: CacheTicket | null, objectId: string): Blob | null {
    if (!this.valid(ticket)) return null;
    const blob = this.entries.get(objectId);
    if (!blob) return null;
    // Most recently used last.
    this.entries.delete(objectId);
    this.entries.set(objectId, blob);
    return blob;
  }

  /** Keep bytes read under `ticket`, if it is still current; trim to the cap. */
  store(ticket: CacheTicket | null, objectId: string, blob: Blob) {
    if (!this.valid(ticket) || blob.size > ENTRY_LIMIT_BYTES) return;
    this.drop(objectId);
    this.entries.set(objectId, blob);
    this.total += blob.size;
    for (const [oldest, kept] of this.entries) {
      if (this.total <= this.limit) break;
      this.entries.delete(oldest);
      this.total -= kept.size;
    }
  }

  /** Forget one object's bytes, for example once it is known to be gone. */
  drop(objectId: string) {
    const blob = this.entries.get(objectId);
    if (!blob) return;
    this.entries.delete(objectId);
    this.total -= blob.size;
  }

  /** Object IDs kept, least recently used first (for tests). */
  objects(): string[] {
    return [...this.entries.keys()];
  }

  /** The bytes kept, in total (for tests). */
  size() {
    return this.total;
  }

  private valid(ticket: CacheTicket | null): ticket is CacheTicket {
    return (
      !!ticket &&
      ticket.epoch === this.epoch &&
      same(ticket.scope, this.scope) &&
      fileWritesEnabled()
    );
  }
}

/** The app's attachment cache. */
export const attachmentCache = new AttachmentCache();

// Turning files off clears the bytes (R3-3).
onFileWritesChange(() => {
  if (!fileWritesEnabled()) attachmentCache.clear();
});
