import { describe, expect, test } from "vitest";
import { api, components } from "../convex/_generated/api";
import {
  NEW,
  OLD,
  RELAY_SECRET,
  SITE,
  account,
  connect,
  post,
  relay,
  requestReset,
  resetToken,
  sessionValid,
  setup,
  signIn,
  useRelayStub,
  type T,
} from "./auth-harness";

useRelayStub();

/** Signed in with a live session, as the app's Convex client would be. */
async function signedIn(t: T, email: string, password = OLD, create = true) {
  const person = create
    ? await account(t, email, password)
    : await principalOf(t, email);
  await signIn(t, email, password);
  const sessions = (await t.run((ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: person.authUserId! }],
      paginationOpts: { numItems: 50, cursor: null },
    }),
  )) as { page: { _id: string; createdAt: number }[] };
  const session = sessions.page.sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const as = t.withIdentity({
    subject: person.authUserId!,
    sessionId: session._id,
    issuer: SITE,
  });
  return { person, as };
}

/** Reset the password through the emailed link, optionally from a browser. */
async function resetWith(t: T, device: string | undefined, to = NEW) {
  relay.messages = [];
  await requestReset(t, "ada@example.com");
  await t.action(api.passwords.reset, {
    token: resetToken(relay.messages[0]!),
    newPassword: to,
    agents: "keep",
    ...(device ? { device } : {}),
  });
}

async function principalOf(t: T, email: string) {
  return (await t.run((ctx) =>
    ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique(),
  ))!;
}

describe("password reset", () => {
  test("emailed link resets once, signs out every device and disconnects agents on request", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    const connectionId = await connect(t, person._id);
    const phone = (await signIn(t, "ada@example.com", OLD))!;
    const laptop = (await signIn(t, "ada@example.com", OLD))!;
    expect(await sessionValid(t, phone)).toBe(true);

    await requestReset(t, "ada@example.com");
    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]).toMatchObject({
      url: `${SITE}/internal/email`,
      authorization: `Bearer ${RELAY_SECRET}`,
      body: { kind: "reset", to: "ada@example.com" },
    });
    const token = resetToken(relay.messages[0]!);
    // Asking for a reset changes nothing by itself.
    expect(await sessionValid(t, phone)).toBe(true);

    // A wrong token fails without signing anyone out.
    await expect(
      t.action(api.passwords.reset, {
        token: "x".repeat(24),
        newPassword: NEW,
        agents: "disconnect",
      }),
    ).rejects.toThrow(/expired or was already used/);
    expect(await sessionValid(t, laptop)).toBe(true);

    const result = await t.action(api.passwords.reset, {
      token,
      newPassword: NEW,
      agents: "disconnect",
    });
    expect(result).toMatchObject({
      email: "ada@example.com",
      agentsDisconnected: 1,
    });
    expect(await sessionValid(t, phone)).toBe(false);
    expect(await sessionValid(t, laptop)).toBe(false);
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.revokedAt).toBeTypeOf("number");
    expect(await signIn(t, "ada@example.com", OLD)).toBeNull();
    expect(await signIn(t, "ada@example.com", NEW)).toBeTruthy();

    await expect(
      t.action(api.passwords.reset, {
        token,
        newPassword: OLD,
        agents: "keep",
      }),
    ).rejects.toThrow(/expired or was already used/);
    expect(await signIn(t, "ada@example.com", NEW)).toBeTruthy();
  });

  test("other browsers fall behind the reset; the resetting browser stays current", async () => {
    const t = setup();
    const { person, as } = await signedIn(t, "ada@example.com");
    const accountId = person.authUserId!;
    const status = (secret: string) =>
      t.query(api.devices.status, { secret, accountId });
    const laptop = "l".repeat(43);
    const phone = "p".repeat(43);
    await as.mutation(api.devices.bind, { secret: laptop });
    await as.mutation(api.devices.bind, { secret: phone });
    expect(await status(phone)).toEqual({ known: true, behind: false });
    await resetWith(t, laptop);
    expect(await status(laptop)).toEqual({ known: true, behind: false });
    expect(await status(phone)).toEqual({ known: true, behind: true });
    // Once the phone has cleared its copies and signed in again it catches up.
    const again = await signedIn(t, "ada@example.com", NEW, false);
    await again.as.mutation(api.devices.bind, { secret: phone });
    expect(await status(phone)).toEqual({ known: true, behind: false });
  });

  test("a browser's own reset does not cancel clean-up it still owes", async () => {
    const t = setup();
    const { person, as } = await signedIn(t, "ada@example.com");
    const accountId = person.authUserId!;
    const laptop = "l".repeat(43);
    const phone = "p".repeat(43);
    await as.mutation(api.devices.bind, { secret: laptop });
    await as.mutation(api.devices.bind, { secret: phone });
    await resetWith(t, laptop);
    // The phone, still holding copies from before the first reset, resets again.
    await resetWith(t, phone, "another long password");
    expect(
      await t.query(api.devices.status, { secret: phone, accountId }),
    ).toEqual({ known: true, behind: true });
    expect(
      await t.query(api.devices.status, { secret: laptop, accountId }),
    ).toEqual({ known: true, behind: true });
    // A browser unknown here stays unknown: its reset vouches for nothing.
    const unknown = "u".repeat(43);
    await resetWith(t, unknown);
    expect(
      await t.query(api.devices.status, { secret: unknown, accountId }),
    ).toEqual({ known: false, behind: false });
  });

  test("only the browser holding a secret learns anything about it", async () => {
    const t = setup();
    const { person, as } = await signedIn(t, "ada@example.com");
    const accountId = person.authUserId!;
    await as.mutation(api.devices.bind, { secret: "l".repeat(43) });
    const unknown = { known: false, behind: false };
    expect(
      await t.query(api.devices.status, { secret: "x".repeat(43), accountId }),
    ).toEqual(unknown);
    expect(
      await t.query(api.devices.status, { secret: "short", accountId }),
    ).toEqual(unknown);
    await expect(
      t.mutation(api.devices.bind, { secret: "x".repeat(43) }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.devices.bind, { secret: "short" }),
    ).rejects.toThrow();
  });

  test("records per account are bounded without dropping owed clean-up", async () => {
    const t = setup();
    const { person, as } = await signedIn(t, "ada@example.com");
    const accountId = person.authUserId!;
    const owes = "o".repeat(43);
    await as.mutation(api.devices.bind, { secret: owes });
    await resetWith(t, undefined);
    const again = await signedIn(t, "ada@example.com", NEW, false);
    const secret = (i: number) =>
      `d${String(i).padStart(4, "0")}`.padEnd(43, "x");
    for (let i = 0; i < 205; i++)
      await again.as.mutation(api.devices.bind, { secret: secret(i) });
    const count = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("devices")
            .withIndex("by_principal", (q) => q.eq("principalId", person._id))
            .collect()
        ).length,
    );
    expect(count).toBe(200);
    // The browser that still owes clean-up keeps its record; the oldest current ones go.
    expect(
      await t.query(api.devices.status, { secret: owes, accountId }),
    ).toEqual({
      known: true,
      behind: true,
    });
    expect(
      await t.query(api.devices.status, { secret: secret(0), accountId }),
    ).toEqual({ known: false, behind: false });
    expect(
      await t.query(api.devices.status, { secret: secret(204), accountId }),
    ).toEqual({ known: true, behind: false });
  });

  test("keeping agents leaves their connections; other devices still sign out", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    const connectionId = await connect(t, person._id);
    const phone = (await signIn(t, "ada@example.com", OLD))!;
    await requestReset(t, "ada@example.com");
    const result = await t.action(api.passwords.reset, {
      token: resetToken(relay.messages[0]!),
      newPassword: NEW,
      agents: "keep",
    });
    expect(result.agentsDisconnected).toBe(0);
    expect(await sessionValid(t, phone)).toBe(false);
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.revokedAt).toBeUndefined();
  });

  test("the direct reset endpoint is closed, so the agent choice cannot be skipped", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    await requestReset(t, "ada@example.com");
    const response = await post(t, "/reset-password", {
      token: resetToken(relay.messages[0]!),
      newPassword: NEW,
    });
    expect(response.status).toBe(404);
    expect(await signIn(t, "ada@example.com", OLD)).toBeTruthy();
  });

  test("unknown addresses get the same answer and no email", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    const known = await requestReset(t, "ada@example.com");
    const unknown = await requestReset(t, "nobody@example.com");
    expect(unknown).toEqual(known);
    expect(relay.messages).toHaveLength(1);
  });

  test("reset emails are limited per account", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    for (let i = 0; i < 5; i++) await requestReset(t, "ada@example.com");
    expect(relay.messages).toHaveLength(3);
  });

  test("without a relay secret nothing is sent", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    delete process.env.EMAIL_RELAY_SECRET;
    await requestReset(t, "ada@example.com");
    expect(relay.messages).toHaveLength(0);
  });
});

describe("invitation email", () => {
  const owner = (t: T) => signedIn(t, "ada@example.com");

  test("the inviter can email an open invitation's link to its address", async () => {
    const t = setup();
    const { person, as } = await owner(t);
    const invited = await as.mutation(api.invitations.create, {
      email: "bo@example.com",
      notebookId: person.defaultNotebookId!,
      role: "edit",
    });
    if (invited.kind !== "invited") throw new Error("expected invitation");
    expect(
      await as.action(api.invitations.sendEmail, { token: invited.token }),
    ).toBe(true);
    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]!.body).toEqual({
      kind: "invite",
      to: "bo@example.com",
      url: `${SITE}/invite#${invited.token}`,
      inviterName: "Ada",
      target: "Notes",
    });
  });

  test("nobody else can email it, nor once it is withdrawn", async () => {
    const t = setup();
    const { person, as } = await owner(t);
    const invited = await as.mutation(api.invitations.create, {
      email: "bo@example.com",
      notebookId: person.defaultNotebookId!,
      role: "read",
    });
    if (invited.kind !== "invited") throw new Error("expected invitation");
    const { as: stranger } = await signedIn(t, "cy@example.com");
    await expect(
      stranger.action(api.invitations.sendEmail, { token: invited.token }),
    ).rejects.toThrow(/no longer valid/);
    await expect(
      t.action(api.invitations.sendEmail, { token: invited.token }),
    ).rejects.toThrow();
    const pending = await as.query(api.invitations.pending, {});
    await as.mutation(api.invitations.revoke, { invitationId: pending[0]!.id });
    await expect(
      as.action(api.invitations.sendEmail, { token: invited.token }),
    ).rejects.toThrow(/no longer valid/);
    expect(relay.messages).toHaveLength(0);
  });

  test("a failed send reports false and the link still works", async () => {
    const t = setup();
    const { person, as } = await owner(t);
    const invited = await as.mutation(api.invitations.create, {
      email: "bo@example.com",
      notebookId: person.defaultNotebookId!,
      role: "read",
    });
    if (invited.kind !== "invited") throw new Error("expected invitation");
    relay.status = 502;
    expect(
      await as.action(api.invitations.sendEmail, { token: invited.token }),
    ).toBe(false);
    const preview = await t.query(api.invitations.preview, {
      token: invited.token,
    });
    expect(preview?.status).toBe("open");
  });
});
