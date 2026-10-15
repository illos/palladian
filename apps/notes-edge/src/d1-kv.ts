/**
 * A Workers KV-compatible store on D1, for accounts whose deploy token cannot
 * manage KV. It implements the subset the OAuth provider and consent handoff
 * use: get (text or JSON), put with expirationTtl/expiration/metadata, delete,
 * and prefix list with limit and cursor. Unlike KV it is strongly consistent.
 */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
  exec(query: string): Promise<unknown>;
}

interface Row {
  key: string;
  value: string;
  expiration: number | null;
  metadata: string | null;
}

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS oauth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER, metadata TEXT)";
const MAX_LIST = 1000;

type GetType = "text" | "json";
type GetOptions = GetType | { type?: GetType; cacheTtl?: number } | undefined;
interface PutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}
interface ListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

const ready = new WeakMap<D1Like, Promise<unknown>>();
const now = () => Math.floor(Date.now() / 1000);

export class D1KV {
  private readonly db: D1Like;
  constructor(db: D1Like) {
    this.db = db;
  }

  private ensure() {
    let promise = ready.get(this.db);
    if (!promise) {
      promise = this.db.exec(SCHEMA).catch((error: unknown) => {
        ready.delete(this.db);
        throw error;
      });
      ready.set(this.db, promise);
    }
    return promise;
  }

  async get(key: string, options?: GetOptions): Promise<unknown> {
    await this.ensure();
    const row = await this.db
      .prepare("SELECT value, expiration FROM oauth_kv WHERE key = ?")
      .bind(key)
      .first<Pick<Row, "value" | "expiration">>();
    if (!row) return null;
    if (row.expiration !== null && row.expiration <= now()) {
      await this.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options: PutOptions = {}) {
    await this.ensure();
    if (typeof value !== "string")
      throw new TypeError("D1KV stores string values only.");
    const expiration =
      options.expiration ??
      (options.expirationTtl !== undefined
        ? now() + options.expirationTtl
        : null);
    await this.db
      .prepare(
        "INSERT INTO oauth_kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiration = excluded.expiration, metadata = excluded.metadata",
      )
      .bind(
        key,
        value,
        expiration,
        options.metadata === undefined
          ? null
          : JSON.stringify(options.metadata),
      )
      .run();
    // Expired rows are invisible; sweep occasionally so storage stays bounded.
    if (Math.random() < 0.02)
      await this.db
        .prepare(
          "DELETE FROM oauth_kv WHERE expiration IS NOT NULL AND expiration <= ?",
        )
        .bind(now())
        .run();
  }

  /** Atomically remove a live entry and return its value: exactly one caller wins. */
  async take(key: string): Promise<string | null> {
    await this.ensure();
    const row = await this.db
      .prepare(
        "DELETE FROM oauth_kv WHERE key = ? AND (expiration IS NULL OR expiration > ?) RETURNING value",
      )
      .bind(key, now())
      .first<Pick<Row, "value">>();
    return row?.value ?? null;
  }

  async delete(key: string) {
    await this.ensure();
    await this.db.prepare("DELETE FROM oauth_kv WHERE key = ?").bind(key).run();
  }

  async list(options: ListOptions = {}) {
    await this.ensure();
    const prefix = options.prefix ?? "";
    const limit = Math.min(MAX_LIST, Math.max(1, options.limit ?? MAX_LIST));
    const after = options.cursor ?? "";
    // Keys are ASCII; U+FFFF sorts after every key with this prefix under BINARY collation.
    const rows = await this.db
      .prepare(
        "SELECT key, expiration, metadata FROM oauth_kv WHERE key >= ? AND key < ? AND key > ? " +
          "AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?",
      )
      .bind(prefix, prefix + "￿", after, now(), limit + 1)
      .all<Omit<Row, "value">>();
    const page = rows.results.slice(0, limit);
    const complete = rows.results.length <= limit;
    return {
      keys: page.map((row) => ({
        name: row.key,
        ...(row.expiration !== null ? { expiration: row.expiration } : {}),
        ...(row.metadata !== null
          ? { metadata: JSON.parse(row.metadata) }
          : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: page[page.length - 1]!.key }),
      cacheStatus: null,
    };
  }
}

/**
 * Remove dynamically registered clients that never completed an authorization
 * within a day. Clients with any grant are kept, so connected agents last
 * until the person disconnects them.
 */
export async function purgeAbandonedClients(
  db: D1Like,
  olderThanSeconds = 86_400,
) {
  await db.exec(SCHEMA);
  await db
    .prepare(
      "DELETE FROM oauth_kv WHERE key LIKE 'client:%' " +
        "AND json_extract(value, '$.registrationDate') < ? " +
        "AND NOT EXISTS (SELECT 1 FROM oauth_kv AS g WHERE g.key LIKE 'grant:%' " +
        "AND json_extract(g.value, '$.clientId') = substr(oauth_kv.key, 8))",
    )
    .bind(now() - olderThanSeconds)
    .run();
}

/** Registrations recorded in the last hour, for a hard cap on anonymous DCR. */
export async function recentRegistrations(db: D1Like, windowSeconds = 3600) {
  await db.exec(SCHEMA);
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM oauth_kv WHERE key LIKE 'client:%' " +
        "AND json_extract(value, '$.registrationDate') > ?",
    )
    .bind(now() - windowSeconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
