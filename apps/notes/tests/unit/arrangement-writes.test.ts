import type { ConvexReactClient } from "convex/react";
import { describe, expect, test } from "vitest";
import { setOrder, setPositions } from "../../src/note-tools";

/**
 * The write contract that replaced the app's write queue (A6 review round
 * 4): a reorder's batches are all handed to Convex at once, back to back, so
 * the client sends them contiguously and in order; nothing in the app waits
 * on an earlier write; every write names its account.
 */
function fakeClient() {
  const calls: { args: Record<string, unknown> }[] = [];
  const pending: {
    resolve: (value: { version: number }) => void;
    reject: (error: Error) => void;
  }[] = [];
  const client = {
    mutation: (_fn: unknown, args: Record<string, unknown>) => {
      calls.push({ args });
      return new Promise<{ version: number }>((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
  } as unknown as ConvexReactClient;
  return { client, calls, pending };
}

const entries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ noteId: `n${i}`, key: "V" }));

describe("arrangement writes", () => {
  test("a reorder's batches are all sent at once, in order, with the account", async () => {
    const { client, calls, pending } = fakeClient();
    const saving = setPositions(client, "acct-1", "nb", entries(250));
    // All three batches were handed over before any answered.
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.args.entries as unknown[]).length)).toEqual([
      100, 100, 50,
    ]);
    expect(calls.every((c) => c.args.account === "acct-1")).toBe(true);
    expect((calls[0]!.args.entries as { noteId: string }[])[0]!.noteId).toBe(
      "n0",
    );
    expect((calls[2]!.args.entries as { noteId: string }[])[0]!.noteId).toBe(
      "n200",
    );
    pending[2]!.resolve({ version: 9 });
    pending[0]!.resolve({ version: 7 });
    pending[1]!.resolve({ version: 8 });
    await expect(saving).resolves.toBe(9);
  });

  test("a later write does not wait for an earlier one that has not answered", () => {
    const { client, calls } = fakeClient();
    void setPositions(client, "acct-1", "nb", entries(1));
    void setOrder(client, "acct-1", "all", "alpha");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual({
      account: "acct-1",
      list: "all",
      order: "alpha",
    });
  });

  test("a refused batch fails the reorder; the others may still apply", async () => {
    const { client, pending } = fakeClient();
    const saving = setPositions(client, "acct-1", "nb", entries(250));
    pending[0]!.resolve({ version: 1 });
    pending[1]!.reject(new Error("refused"));
    pending[2]!.resolve({ version: 2 });
    // The overlay is dropped on failure; the synced arrangement then shows
    // whatever batches the server accepted (documented as partial).
    await expect(saving).rejects.toThrow("refused");
  });
});
