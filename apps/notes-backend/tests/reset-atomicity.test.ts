import { describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import {
  NEW,
  OLD,
  account,
  connect,
  relay,
  requestReset,
  resetToken,
  sessionValid,
  setup,
  signIn,
  useRelayStub,
} from "./auth-harness";

// The agent step is the last write of the reset transaction; failing it
// proves every earlier write (link, password, sessions) rolls back with it.
const fault = vi.hoisted(() => ({ agents: false }));
vi.mock("../convex/connections", async (original) => {
  const actual = await original<typeof import("../convex/connections")>();
  return {
    ...actual,
    disconnectAgents: async (
      ...args: Parameters<typeof actual.disconnectAgents>
    ) => {
      if (fault.agents) throw new Error("injected failure");
      return actual.disconnectAgents(...args);
    },
  };
});

useRelayStub();

describe("password reset atomicity", () => {
  test("a failure late in the reset changes nothing and the link still works", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    const connectionId = await connect(t, person._id);
    const phone = (await signIn(t, "ada@example.com", OLD))!;
    await requestReset(t, "ada@example.com");
    const token = resetToken(relay.messages[0]!);

    fault.agents = true;
    await expect(
      t.action(api.passwords.reset, {
        token,
        newPassword: NEW,
        agents: "disconnect",
      }),
    ).rejects.toThrow(/injected failure/);
    fault.agents = false;

    expect(await sessionValid(t, phone)).toBe(true);
    expect(await signIn(t, "ada@example.com", OLD)).toBeTruthy();
    expect(await signIn(t, "ada@example.com", NEW)).toBeNull();
    const untouched = await t.run((ctx) => ctx.db.get(connectionId));
    expect(untouched?.revokedAt).toBeUndefined();
    const counted = await t.run((ctx) => ctx.db.get(person._id));
    expect(counted?.resetEpoch).toBeUndefined();

    const result = await t.action(api.passwords.reset, {
      token,
      newPassword: NEW,
      agents: "disconnect",
    });
    expect(result.agentsDisconnected).toBe(1);
    expect(await sessionValid(t, phone)).toBe(false);
    expect(await signIn(t, "ada@example.com", NEW)).toBeTruthy();
    const revoked = await t.run((ctx) => ctx.db.get(connectionId));
    expect(revoked?.revokedAt).toBeTypeOf("number");
  });
});
