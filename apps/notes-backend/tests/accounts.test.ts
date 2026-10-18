/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

const SITE = "https://site.test";
const RELAY_SECRET = "relay-secret-".padEnd(48, "x");
process.env.SITE_URL = SITE;
process.env.CONVEX_SITE_URL = "https://backend.test";
process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(48, "y");

const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
type T = ReturnType<typeof setup>;

interface Relayed {
  url: string;
  authorization: string | null;
  body: { kind: string; to: string; url: string; target?: string | null };
}
let relayed: Relayed[];
let relayStatus: number;

beforeEach(() => {
  vi.useFakeTimers();
  relayed = [];
  relayStatus = 204;
  process.env.EMAIL_RELAY_SECRET = RELAY_SECRET;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    relayed.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)) as Relayed["body"],
    });
    return new Response(null, { status: relayStatus });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function post(t: T, path: string, body: unknown, cookie?: string) {
  return t.fetch(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      // The cross-domain plugin returns cookies only to clients that send this.
      "Better-Auth-Cookie": cookie ?? "",
    },
    body: JSON.stringify(body),
  });
}

/** Sign in as a device would; returns its cross-domain session cookie. */
async function signIn(t: T, email: string, password: string) {
  const response = await post(t, "/sign-in/email", { email, password });
  if (!response.ok) return null;
  const set = response.headers.get("Set-Better-Auth-Cookie") ?? "";
  return set
    .split(/,(?=\s*[\w.-]+=)/)
    .map((part) => part.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

async function sessionValid(t: T, cookie: string) {
  const response = await t.fetch("/api/auth/get-session", {
    headers: { Origin: SITE, "Better-Auth-Cookie": cookie },
  });
  const body = (await response.json()) as { user?: unknown } | null;
  return !!body?.user;
}

/** A real account: an owner setup link accepted through Better Auth. */
async function account(t: T, email: string, password: string) {
  const { token } = await t.mutation(internal.provision.setupOwner, { email });
  await t.action(api.invitations.accept, { token, name: "Ada", password });
  const principal = await t.run((ctx) =>
    ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique(),
  );
  return principal!;
}

async function connect(t: T, controllerId: Id<"principals">) {
  return t.run(async (ctx) => {
    const agentId = await ctx.db.insert("principals", {
      kind: "agent",
      name: "Claude",
      controllerId,
      createdAt: Date.now(),
    });
    return ctx.db.insert("connections", {
      agentId,
      controllerId,
      clientId: "client",
      clientName: "Claude",
      redirectHost: "claude.ai",
      createdAt: Date.now(),
    });
  });
}

async function requestReset(t: T, email: string) {
  const response = await post(t, "/request-password-reset", { email });
  expect(response.status).toBe(200);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return (await response.json()) as { status: boolean; message: string };
}

function resetToken(message: Relayed) {
  const prefix = `${SITE}/reset#`;
  expect(message.body.url.startsWith(prefix)).toBe(true);
  return message.body.url.slice(prefix.length);
}

const OLD = "correct horse battery";
const NEW = "staple gun lighthouse";

describe("password reset", () => {
  test("emailed link resets once, signs out every device and disconnects agents on request", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    const connectionId = await connect(t, person._id);
    const phone = (await signIn(t, "ada@example.com", OLD))!;
    const laptop = (await signIn(t, "ada@example.com", OLD))!;
    expect(await sessionValid(t, phone)).toBe(true);

    await requestReset(t, "ada@example.com");
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      url: `${SITE}/internal/email`,
      authorization: `Bearer ${RELAY_SECRET}`,
      body: { kind: "reset", to: "ada@example.com" },
    });
    const token = resetToken(relayed[0]!);
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
    expect(result).toEqual({ email: "ada@example.com", agentsDisconnected: 1 });
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

  test("keeping agents leaves their connections; other devices still sign out", async () => {
    const t = setup();
    const person = await account(t, "ada@example.com", OLD);
    const connectionId = await connect(t, person._id);
    const phone = (await signIn(t, "ada@example.com", OLD))!;
    await requestReset(t, "ada@example.com");
    const result = await t.action(api.passwords.reset, {
      token: resetToken(relayed[0]!),
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
      token: resetToken(relayed[0]!),
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
    expect(relayed).toHaveLength(1);
  });

  test("reset emails are limited per account", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    for (let i = 0; i < 5; i++) await requestReset(t, "ada@example.com");
    expect(relayed).toHaveLength(3);
  });

  test("without a relay secret nothing is sent", async () => {
    const t = setup();
    await account(t, "ada@example.com", OLD);
    delete process.env.EMAIL_RELAY_SECRET;
    await requestReset(t, "ada@example.com");
    expect(relayed).toHaveLength(0);
  });
});

describe("invitation email", () => {
  /** Signed in with a live session, as the app's Convex client would be. */
  async function signedIn(t: T, email: string) {
    const person = await account(t, email, OLD);
    await signIn(t, email, OLD);
    const session = (await t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "userId", value: person.authUserId! }],
      }),
    )) as { _id: string };
    const as = t.withIdentity({
      subject: person.authUserId!,
      sessionId: session._id,
      issuer: SITE,
    });
    return { person, as };
  }
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
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.body).toEqual({
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
    expect(relayed).toHaveLength(0);
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
    relayStatus = 502;
    expect(
      await as.action(api.invitations.sendEmail, { token: invited.token }),
    ).toBe(false);
    const preview = await t.query(api.invitations.preview, {
      token: invited.token,
    });
    expect(preview?.status).toBe("open");
  });
});
