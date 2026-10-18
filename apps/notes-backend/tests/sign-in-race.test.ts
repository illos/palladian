import { createFunctionHandle } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import {
  NEW,
  OLD,
  account,
  relay,
  requestReset,
  resetToken,
  setup,
  signIn,
  useRelayStub,
  type T,
} from "./auth-harness";

// Password checks run in action code between database transactions. The
// test pauses sign-in right after its Nth password check so a reset can
// commit there, as a slow or interleaved sign-in would meet it.
const gate = vi.hoisted(() => ({
  pauseAfterCheck: 0,
  checks: 0,
  reached: null as null | (() => void),
  release: null as null | (() => void),
}));
vi.mock("better-auth/minimal", async (original) => {
  const actual = await original<typeof import("better-auth/minimal")>();
  const { verifyPassword } = await import("better-auth/crypto");
  return {
    ...actual,
    betterAuth: ((options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth({
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword!,
          password: {
            verify: async (data: { hash: string; password: string }) => {
              const valid = await verifyPassword(data);
              if (++gate.checks === gate.pauseAfterCheck) {
                gate.reached?.();
                await new Promise<void>((resolve) => (gate.release = resolve));
              }
              return valid;
            },
          },
        },
      })) as typeof actual.betterAuth,
  };
});

useRelayStub();

async function sessionsOf(t: T, userId: string) {
  const result = (await t.run((ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: userId }],
      paginationOpts: { numItems: 50, cursor: null },
    }),
  )) as { page: unknown[] };
  return result.page.length;
}

async function reset(t: T, email: string) {
  relay.messages = [];
  await requestReset(t, email);
  await t.action(api.passwords.reset, {
    token: resetToken(relay.messages[0]!),
    newPassword: NEW,
    agents: "keep",
  });
}

/** Sign in with the old password, letting a reset commit after check `n`. */
async function signInAcrossReset(t: T, n: number) {
  gate.checks = 0;
  gate.pauseAfterCheck = n;
  const reached = new Promise<void>((resolve) => (gate.reached = resolve));
  const signingIn = signIn(t, "ada@example.com", OLD);
  await reached;
  gate.pauseAfterCheck = 0;
  await reset(t, "ada@example.com");
  gate.release!();
  return signingIn;
}

describe("a sign-in with the old password cannot outlive a reset", () => {
  test("reset right after Better Auth verified the old password", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    expect(await signInAcrossReset(t, 1)).toBeNull();
    expect(await sessionsOf(t, person.authUserId!)).toBe(0);
    expect(await signIn(t, "ada@example.com", NEW)).toBeTruthy();
  });

  test("reset right after the second check, before the session is written", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    expect(await signInAcrossReset(t, 2)).toBeNull();
    expect(await sessionsOf(t, person.authUserId!)).toBe(0);
    expect(await signIn(t, "ada@example.com", NEW)).toBeTruthy();
  });

  test("the session write itself refuses a count from before the reset", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    await reset(t, "ada@example.com");
    const write = (credentialEpoch: number) =>
      t.run(async (ctx) => {
        const now = Date.now();
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "session",
            data: {
              userId: person.authUserId!,
              token: crypto.randomUUID(),
              expiresAt: now + 3_600_000,
              createdAt: now,
              updatedAt: now,
              credentialEpoch,
            },
          },
          onCreateHandle: await createFunctionHandle(internal.auth.onCreate),
        });
      });
    await expect(write(0)).rejects.toThrow(/password changed/);
    expect(await sessionsOf(t, person.authUserId!)).toBe(0);
    await write(1);
    expect(await sessionsOf(t, person.authUserId!)).toBe(1);
  });
});
