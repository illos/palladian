import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { D1KV, type D1Like } from "../src/d1-kv.ts";

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
