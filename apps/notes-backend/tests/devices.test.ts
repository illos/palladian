import { describe, expect, test } from "vitest";
import { api, components } from "../convex/_generated/api";
import { deviceLabel } from "../convex/devices";
import {
  OLD,
  SITE,
  account,
  sessionValid,
  setup,
  signIn,
  useRelayStub,
  type T,
} from "./auth-harness";

useRelayStub();

const AGENT_ISSUER = "https://agent.test";
process.env.AGENT_JWT_ISSUER = AGENT_ISSUER;

const IPHONE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

interface Row {
  _id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  token: string;
}

/** Every session row of the user, expired or not, oldest first. */
async function sessions(t: T, authUserId: string) {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = (await t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session",
        where: [{ field: "userId", value: authUserId }],
        paginationOpts: { numItems: 100, cursor },
      }),
    )) as { page: Row[]; isDone: boolean; continueCursor: string };
    rows.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

async function setUserAgent(t: T, id: string, userAgent: string) {
  await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "session",
        where: [{ field: "_id", value: id }],
        update: { userAgent },
      },
    }),
  );
}

/** Ada signed in on a phone and a laptop, acting from the laptop. */
async function twoDevices(t: T) {
  const person = await account(t, "ada@example.com", OLD);
  // Accepting the invitation signs in the device that accepted it.
  const existing = await sessions(t, person.authUserId!);
  const phone = (await signIn(t, "ada@example.com", OLD))!;
  const laptop = (await signIn(t, "ada@example.com", OLD))!;
  const [phoneRow, laptopRow] = (await sessions(t, person.authUserId!)).slice(
    existing.length,
  );
  await setUserAgent(t, phoneRow!._id, IPHONE_APP);
  await setUserAgent(t, laptopRow!._id, MAC_SAFARI);
  const as = t.withIdentity({
    subject: person.authUserId!,
    sessionId: laptopRow!._id,
    issuer: SITE,
  });
  return {
    person,
    phone,
    laptop,
    phoneRow: phoneRow!,
    laptopRow: laptopRow!,
    as,
  };
}

describe("devices", () => {
  test("lists signed-in devices by label and dates, this device first, without tokens", async () => {
    const t = setup();
    const { as, phoneRow, laptopRow } = await twoDevices(t);
    const list = (await as.query(api.devices.list, {})).devices;
    expect(list[0]).toMatchObject({
      id: laptopRow._id,
      label: "Mac · Safari",
      current: true,
    });
    const phone = list.find((row) => row.id === phoneRow._id);
    expect(phone).toMatchObject({
      label: "iPhone · Home Screen app",
      current: false,
    });
    expect(phone!.signedInAt).toBeTypeOf("number");
    expect(phone!.lastActiveAt).toBeTypeOf("number");
    expect(JSON.stringify(list)).not.toContain(phoneRow.token);
    expect(JSON.stringify(list)).not.toContain(laptopRow.token);
    for (const row of list)
      expect(Object.keys(row).sort()).toEqual(
        ["current", "id", "label", "lastActiveAt", "signedInAt"].sort(),
      );
  });

  test("signing out another device ends its session at once", async () => {
    const t = setup();
    const { as, phone, laptop, phoneRow } = await twoDevices(t);
    await as.mutation(api.devices.revoke, { id: phoneRow._id });
    expect(await sessionValid(t, phone)).toBe(false);
    expect(await sessionValid(t, laptop)).toBe(true);
    const list = (await as.query(api.devices.list, {})).devices;
    expect(list.some((row) => row.id === phoneRow._id)).toBe(false);
    // The phone's Convex calls stop at once: its session no longer exists.
    const phoneAs = t.withIdentity({
      subject: phoneRow.userId,
      sessionId: phoneRow._id,
      issuer: SITE,
    });
    expect(await phoneAs.query(api.account.me, {})).toBeNull();
    await expect(
      as.mutation(api.devices.revoke, { id: phoneRow._id }),
    ).rejects.toThrow(/already signed out/);
  });

  test("this device signs out through Sign out, not the device list", async () => {
    const t = setup();
    const { as, laptop, laptopRow } = await twoDevices(t);
    await expect(
      as.mutation(api.devices.revoke, { id: laptopRow._id }),
    ).rejects.toThrow(/Use Sign out/);
    expect(await sessionValid(t, laptop)).toBe(true);
  });

  test("signing out all other devices keeps this one", async () => {
    const t = setup();
    const { as, phone, laptop, person } = await twoDevices(t);
    const before = (await sessions(t, person.authUserId!)).length;
    expect(await as.mutation(api.devices.revokeOthers, {})).toEqual({
      revoked: before - 1,
      done: true,
    });
    expect(await sessionValid(t, phone)).toBe(false);
    expect(await sessionValid(t, laptop)).toBe(true);
    expect((await as.query(api.devices.list, {})).devices).toHaveLength(1);
  });

  test("nobody can list or end another person's devices", async () => {
    const t = setup();
    const { phone, phoneRow } = await twoDevices(t);
    const bea = await account(t, "bea@example.com", OLD);
    await signIn(t, "bea@example.com", OLD);
    const beaRow = (await sessions(t, bea.authUserId!)).at(-1)!;
    const asBea = t.withIdentity({
      subject: bea.authUserId!,
      sessionId: beaRow._id,
      issuer: SITE,
    });
    const list = (await asBea.query(api.devices.list, {})).devices;
    expect(list.some((row) => row.id === phoneRow._id)).toBe(false);
    await expect(
      asBea.mutation(api.devices.revoke, { id: phoneRow._id }),
    ).rejects.toThrow(/already signed out/);
    expect(await sessionValid(t, phone)).toBe(true);
    await asBea.mutation(api.devices.revokeOthers, {});
    expect(await sessionValid(t, phone)).toBe(true);
  });

  test("agents, signed-out, expired, revoked and claimless callers change nothing", async () => {
    const t = setup();
    const { person, phoneRow, laptopRow } = await twoDevices(t);
    const agent = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("principals", {
        kind: "agent",
        name: "Claude",
        controllerId: person._id,
        createdAt: Date.now(),
      });
      const connectionId = await ctx.db.insert("connections", {
        agentId,
        controllerId: person._id,
        clientId: "client",
        clientName: "Claude",
        redirectHost: "claude.ai",
        createdAt: Date.now(),
      });
      return { agentId, connectionId };
    });
    const asAgent = t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: agent.agentId,
      cid: agent.connectionId,
    });
    // A real agent identity: it can read the owner's account, not their devices.
    expect(await asAgent.query(api.account.me, {})).toMatchObject({
      kind: "agent",
    });
    const before = (await sessions(t, person.authUserId!)).map(
      (row) => row._id,
    );
    const unchanged = async () =>
      expect(
        (await sessions(t, person.authUserId!)).map((row) => row._id),
      ).toEqual(before);
    const refused = async (
      caller: ReturnType<T["withIdentity"]> | T,
      pattern: RegExp,
    ) => {
      await expect(caller.query(api.devices.list, {})).rejects.toThrow(pattern);
      await expect(
        caller.mutation(api.devices.revoke, { id: phoneRow._id }),
      ).rejects.toThrow(pattern);
      await expect(
        caller.mutation(api.devices.revokeOthers, {}),
      ).rejects.toThrow(pattern);
      await unchanged();
    };
    await refused(asAgent, /Only people/);
    await refused(t, /Sign in/);
    // A person's token without a session claim is not a live session: the
    // Better Auth lookup itself refuses it before any device code runs.
    await refused(
      t.withIdentity({ subject: person.authUserId!, issuer: SITE }),
      /./,
    );

    // An expired session no longer counts, even though its row remains.
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "session",
          where: [{ field: "_id", value: laptopRow._id }],
          update: { expiresAt: Date.now() - 1000 },
        },
      }),
    );
    const asExpired = t.withIdentity({
      subject: person.authUserId!,
      sessionId: laptopRow._id,
      issuer: SITE,
    });
    await refused(asExpired, /Sign in/);

    // A device that was signed out cannot act with its old token.
    const asPhone = t.withIdentity({
      subject: person.authUserId!,
      sessionId: phoneRow._id,
      issuer: SITE,
    });
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "session",
          where: [{ field: "_id", value: phoneRow._id }],
        },
      }),
    );
    before.splice(before.indexOf(phoneRow._id), 1);
    await refused(asPhone, /Sign in/);
  });

  test("many sessions: listing is bounded and other devices sign out in batches", async () => {
    const t = setup();
    const { as, person, laptopRow, laptop } = await twoDevices(t);
    const userId = person.authUserId!;
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 160; i++)
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "session",
            data: {
              userId,
              token: `bulk-${i}`.padEnd(32, "x"),
              // Every fourth one has already expired.
              expiresAt: i % 4 === 0 ? now - 1000 : now + 86_400_000,
              createdAt: now - 10_000 + i,
              updatedAt: now - 10_000 + i,
            },
          },
        });
    });
    const first = await as.query(api.devices.list, {});
    expect(first.devices.length).toBeLessThanOrEqual(51);
    expect(first.more).toBe(true);
    expect(first.devices[0]).toMatchObject({
      id: laptopRow._id,
      current: true,
    });
    const live = (await sessions(t, userId)).filter(
      (row) => row.expiresAt > Date.now(),
    ).length;
    let revoked = 0;
    let calls = 0;
    for (;;) {
      const batch = await as.mutation(api.devices.revokeOthers, {});
      revoked += batch.revoked;
      calls++;
      if (batch.done) break;
      expect(calls).toBeLessThan(10);
    }
    expect(calls).toBeGreaterThan(1);
    // Every other live session was counted once; expired ones were removed too.
    expect(revoked).toBe(live - 1);
    expect((await sessions(t, userId)).map((row) => row._id)).toEqual([
      laptopRow._id,
    ]);
    expect(await sessionValid(t, laptop)).toBe(true);
    const after = await as.query(api.devices.list, {});
    expect(after).toEqual({
      devices: [expect.objectContaining({ id: laptopRow._id, current: true })],
      more: false,
    });
  });

  test("device labels name the system and browser only", () => {
    expect(deviceLabel(IPHONE_APP)).toBe("iPhone · Home Screen app");
    expect(deviceLabel(MAC_SAFARI)).toBe("Mac · Safari");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
      ),
    ).toBe("Windows · Edge");
    expect(
      deviceLabel(
        "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
      ),
    ).toBe("Linux · Firefox");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Chrome");
    expect(deviceLabel(null)).toBe("Unknown device");
  });
});
