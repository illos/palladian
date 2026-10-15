import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  D1KV,
  purgeAbandonedClients,
  recentRegistrations,
  reserveRegistration,
  type D1Like,
} from "../src/d1-kv.ts";

type Value = string | number | null;
function fakeD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(query) {
      return {
        bind(...values) {
          const statement = db.prepare(query);
          const args = values as Value[];
          return {
            first: async <T>() =>
              (statement.get(...args) as T | undefined) ?? null,
            all: async <T>() => ({ results: statement.all(...args) as T[] }),
            run: async () => statement.run(...args),
          };
        },
      };
    },
    exec: async (query) => db.exec(query),
  };
}

afterEach(() => vi.useRealTimers());

describe("D1KV", () => {
  test("stores text and JSON, overwrites and deletes", async () => {
    const kv = new D1KV(fakeD1());
    expect(await kv.get("missing")).toBeNull();
    await kv.put("a", JSON.stringify({ n: 1 }));
    expect(await kv.get("a")).toBe('{"n":1}');
    expect(await kv.get("a", { type: "json" })).toEqual({ n: 1 });
    expect(await kv.get("a", "json")).toEqual({ n: 1 });
    await kv.put("a", JSON.stringify({ n: 2 }));
    expect(await kv.get("a", { type: "json" })).toEqual({ n: 2 });
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  test("expires entries by TTL and absolute expiration", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const kv = new D1KV(fakeD1());
    await kv.put("ttl", "x", { expirationTtl: 60 });
    await kv.put("abs", "y", { expiration: 1_000_000_000 + 120 });
    await kv.put("forever", "z");
    vi.setSystemTime(1_000_000_000_000 + 61_000);
    expect(await kv.get("ttl")).toBeNull();
    expect(await kv.get("abs")).toBe("y");
    expect((await kv.list()).keys.map((k) => k.name)).toEqual([
      "abs",
      "forever",
    ]);
    vi.setSystemTime(1_000_000_000_000 + 121_000);
    expect(await kv.get("abs")).toBeNull();
    expect(await kv.get("forever")).toBe("z");
  });

  test("lists by prefix with metadata, limit and cursor", async () => {
    const kv = new D1KV(fakeD1());
    for (const id of ["1", "2", "3"])
      await kv.put(`grant:user:${id}`, "{}", { metadata: { id } });
    await kv.put("grant:other:9", "{}");
    await kv.put("client:abc", "{}");
    const first = await kv.list({ prefix: "grant:user:", limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual([
      "grant:user:1",
      "grant:user:2",
    ]);
    expect(first.keys[0]!.metadata).toEqual({ id: "1" });
    expect(first.list_complete).toBe(false);
    const second = await kv.list({
      prefix: "grant:user:",
      limit: 2,
      cursor: first.cursor ?? null,
    });
    expect(second.keys.map((k) => k.name)).toEqual(["grant:user:3"]);
    expect(second.list_complete).toBe(true);
    expect((await kv.list({ prefix: "grant:" })).keys).toHaveLength(4);
  });
});

describe("consent and registration hygiene", () => {
  test("take hands a pending entry to exactly one caller", async () => {
    const kv = new D1KV(fakeD1());
    await kv.put("connect:k", "pending", { expirationTtl: 600 });
    const results = await Promise.all([
      kv.take("connect:k"),
      kv.take("connect:k"),
    ]);
    expect(results.filter((value) => value === "pending")).toHaveLength(1);
    expect(await kv.get("connect:k")).toBeNull();
  });

  test("purges day-old registrations that never received a grant", async () => {
    vi.useFakeTimers({ now: 2_000_000_000_000 });
    const db = fakeD1();
    const kv = new D1KV(db);
    const old = Math.floor(Date.now() / 1000) - 2 * 86_400;
    await kv.put(
      "client:abandoned",
      JSON.stringify({ clientId: "abandoned", registrationDate: old }),
    );
    await kv.put(
      "client:connected",
      JSON.stringify({ clientId: "connected", registrationDate: old }),
    );
    await kv.put(
      "client:fresh",
      JSON.stringify({ clientId: "fresh", registrationDate: old + 2 * 86_400 }),
    );
    await kv.put("grant:agent:g1", JSON.stringify({ clientId: "connected" }));
    expect(await recentRegistrations(db)).toBe(1);
    expect(await recentRegistrations(db, 3 * 86_400)).toBe(3);
    await purgeAbandonedClients(db);
    expect(await kv.get("client:abandoned")).toBeNull();
    expect(await kv.get("client:connected")).not.toBeNull();
    expect(await kv.get("client:fresh")).not.toBeNull();
  });
});

describe("review round 2 regressions", () => {
  test("concurrent reservations never exceed the hourly ceiling", async () => {
    const db = fakeD1();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveRegistration(db, 5)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await reserveRegistration(db, 5)).toBe(false);
  });

  test("an expired read never deletes a concurrent replacement", async () => {
    const inner = fakeD1();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let observed!: () => void;
    const seen = new Promise<void>((resolve) => (observed = resolve));
    let intercept = false;
    const db: D1Like = {
      exec: (query) => inner.exec(query),
      prepare: (query) => ({
        bind: (...values) => {
          const bound = inner.prepare(query).bind(...values);
          return {
            ...bound,
            first: async <T>() => {
              const row = await bound.first<T>();
              if (intercept && query.startsWith("SELECT value")) {
                intercept = false;
                observed();
                await gate;
              }
              return row;
            },
          };
        },
      }),
    };
    const kv = new D1KV(db);
    await kv.put("token", "expired", { expiration: 1 });
    intercept = true;
    const stale = kv.get("token");
    await seen;
    await kv.put("token", "fresh", { expirationTtl: 3600 });
    release();
    expect(await stale).toBeNull();
    expect(await kv.get("token")).toBe("fresh");
  });
});
