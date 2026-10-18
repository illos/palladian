/// <reference types="vite/client" />
// Shared harness for tests that drive real Better Auth through the HTTP routes.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

export const SITE = "https://site.test";
export const RELAY_SECRET = "relay-secret-".padEnd(48, "x");
export const OLD = "correct horse battery";
export const NEW = "staple gun lighthouse";
process.env.SITE_URL = SITE;
process.env.CONVEX_SITE_URL = "https://backend.test";
process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(48, "y");

const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

export function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
export type T = ReturnType<typeof setup>;

export interface Relayed {
  url: string;
  authorization: string | null;
  body: { kind: string; to: string; url: string; target?: string | null };
}
/** Messages handed to the email relay, and the status it answers with. */
export const relay = { messages: [] as Relayed[], status: 204 };

/** Fake timers and a stubbed relay around every test in the calling file. */
export function useRelayStub() {
  beforeEach(() => {
    vi.useFakeTimers();
    relay.messages = [];
    relay.status = 204;
    process.env.EMAIL_RELAY_SECRET = RELAY_SECRET;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      relay.messages.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)) as Relayed["body"],
      });
      return new Response(null, { status: relay.status });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export function post(t: T, path: string, body: unknown, cookie?: string) {
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
export async function signIn(t: T, email: string, password: string) {
  const response = await post(t, "/sign-in/email", { email, password });
  if (!response.ok) return null;
  const set = response.headers.get("Set-Better-Auth-Cookie") ?? "";
  return set
    .split(/,(?=\s*[\w.-]+=)/)
    .map((part) => part.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

export async function sessionValid(t: T, cookie: string) {
  const response = await t.fetch("/api/auth/get-session", {
    headers: { Origin: SITE, "Better-Auth-Cookie": cookie },
  });
  const body = (await response.json()) as { user?: unknown } | null;
  return !!body?.user;
}

/** A real account: an owner setup link accepted through Better Auth. */
export async function account(t: T, email: string, password: string) {
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

export async function connect(t: T, controllerId: Id<"principals">) {
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

export async function requestReset(t: T, email: string) {
  const response = await post(t, "/request-password-reset", { email });
  expect(response.status).toBe(200);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return (await response.json()) as { status: boolean; message: string };
}

export function resetToken(message: Relayed) {
  const prefix = `${SITE}/reset#`;
  expect(message.body.url.startsWith(prefix)).toBe(true);
  return message.body.url.slice(prefix.length);
}
