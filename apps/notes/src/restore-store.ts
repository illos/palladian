import type { PendingRestore } from "./restore-keeper";

/**
 * Where this browser keeps its unresolved restores (review round 4): an
 * app-owned IndexedDB database, separate from the notes cache, with one entry
 * per request ID. Every change is one readwrite transaction, and IndexedDB
 * runs readwrite transactions on a store one at a time across all windows of
 * the origin, so two windows cannot overwrite each other's records (R4-2). An
 * insert is only reported once its transaction has committed and the record
 * reads back unchanged (R4-1).
 *
 * localStorage under a lock would not do: each renderer process keeps its own
 * copy of localStorage and learns of other processes' writes asynchronously,
 * so a window holding the lock could still read another window's stale list.
 */
export const RESTORE_DB = "palladian-restores";
const STORE = "restores";

/** A stored entry that does not read as a record. */
export interface CorruptEntry {
  key: string;
  /** Its account, if that much is readable. */
  accountId: string | null;
}

export interface RecordStore {
  /** Every stored entry, valid or not. */
  list(): Promise<{ records: PendingRestore[]; corrupt: CorruptEntry[] }>;
  /**
   * Adds a record unless `limit` entries are stored already. Resolves once
   * the record is committed and reads back unchanged; rejects otherwise.
   */
  add(record: PendingRestore, limit: number): Promise<"added" | "full">;
  /** Marks a record applied, with the revision the restore produced. */
  markApplied(requestId: string, revision: number, at: number): Promise<void>;
  /** Removes entries by key. */
  remove(keys: readonly string[]): Promise<void>;
}

export function isPendingRestore(value: unknown): value is PendingRestore {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    record.accountId.length > 0 &&
    typeof record.noteId === "string" &&
    record.noteId.length > 0 &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    record.requestId.length <= 128 &&
    Number.isSafeInteger(record.revision) &&
    Number.isSafeInteger(record.expectedRevision) &&
    typeof record.versionEndedAt === "number" &&
    typeof record.since === "number" &&
    (record.appliedRevision === undefined ||
      Number.isSafeInteger(record.appliedRevision)) &&
    (record.appliedAt === undefined || typeof record.appliedAt === "number") &&
    (record.appliedRevision === undefined) === (record.appliedAt === undefined)
  );
}

function done(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // The failing request's error: the transaction's own is set only later.
    transaction.onerror = (event) =>
      reject(
        (event.target as IDBRequest | null)?.error ??
          transaction.error ??
          new Error("The restore store refused a change."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("The restore store refused a change."),
      );
  });
}

/** Opens the store, or returns null if this browser offers no IndexedDB. */
export function openRecordStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): RecordStore | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;
  const database = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(RESTORE_DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another window upgrading the database: step aside, reopen later.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
      request.onblocked = () => {
        opening = null;
        reject(new Error("The restore store is blocked by another window."));
      };
    }));
  const transaction = async (mode: IDBTransactionMode) => {
    const db = await database();
    const tx = db.transaction(
      STORE,
      mode,
      mode === "readwrite" ? { durability: "strict" } : {},
    );
    return { tx, store: tx.objectStore(STORE) };
  };

  return {
    async list() {
      const { tx, store } = await transaction("readonly");
      const records: PendingRestore[] = [];
      const corrupt: CorruptEntry[] = [];
      const cursor = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return resolve();
          const value: unknown = at.value;
          const key = String(at.key);
          if (isPendingRestore(value) && value.requestId === key)
            records.push(value);
          else {
            const accountId =
              typeof value === "object" &&
              value !== null &&
              typeof (value as { accountId?: unknown }).accountId === "string"
                ? (value as { accountId: string }).accountId
                : null;
            corrupt.push({ key, accountId });
          }
          at.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      await committed(tx);
      return { records, corrupt };
    },

    async add(record, limit) {
      const { tx, store } = await transaction("readwrite");
      const finished = committed(tx);
      const count = store.count();
      await done(count);
      if (count.result >= limit) {
        await finished;
        return "full";
      }
      store.add(record, record.requestId);
      await finished;
      // Read it back: only a record that is really there may be sent.
      const check = await transaction("readonly");
      const read = check.store.get(record.requestId);
      await done(read);
      await committed(check.tx);
      if (JSON.stringify(read.result) !== JSON.stringify(record))
        throw new Error("The restore record did not read back.");
      return "added";
    },

    async markApplied(requestId, revision, at) {
      const { tx, store } = await transaction("readwrite");
      const finished = committed(tx);
      const read = store.get(requestId);
      await done(read);
      const value: unknown = read.result;
      if (isPendingRestore(value))
        store.put(
          { ...value, appliedRevision: revision, appliedAt: at },
          requestId,
        );
      await finished;
    },

    async remove(keys) {
      const { tx, store } = await transaction("readwrite");
      const finished = committed(tx);
      for (const key of keys) store.delete(key);
      await finished;
    },
  };
}
