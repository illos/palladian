import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionService } from "./session";

const DEVICE_KEY = "palladian.notes.device.v1";

/**
 * A random secret identifying this browser to the server's device records
 * (D98). Only its hash is stored there; only this browser can ask about it.
 */
export function deviceSecret(): string | null {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[A-Za-z0-9_-]{43}$/.test(stored)) return stored;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    localStorage.setItem(DEVICE_KEY, secret);
    return secret;
  } catch {
    // Without storage the browser cannot take part; it keeps expiry behaviour.
    return null;
  }
}

/** One Convex function call over HTTP, outside the live connection. */
async function convexCall(
  convexURL: string,
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  token?: string,
): Promise<unknown> {
  const response = await fetch(`${convexURL}/api/${kind}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) throw new Error("Device check unavailable");
  const body = (await response.json()) as { status?: unknown; value?: unknown };
  if (body.status !== "success") throw new Error("Device check unavailable");
  return body.value;
}

interface DeviceEntry {
  accountId: string;
  revoked: boolean;
}

async function deviceStatus(
  convexURL: string,
  secret: string,
  signal: AbortSignal,
): Promise<DeviceEntry[]> {
  const value = await convexCall(
    convexURL,
    "query",
    "devices:status",
    { secret },
    signal,
  );
  if (!Array.isArray(value)) throw new Error("Device check unavailable");
  return value as DeviceEntry[];
}

/** The official client owns credentials; the notes display never awaits this module. */
export function createAuthService(siteURL: string, convexURL?: string) {
  const auth = createAuthClient({
    baseURL: siteURL,
    plugins: [convexClient(), crossDomainClient(), passkeyClient()],
  });
  /** Record with the signed-in session that this browser is current. */
  async function bindDevice(secret: string, signal: AbortSignal) {
    const result = await auth.convex.token({
      fetchOptions: { signal, throw: false },
    });
    const token = result.data?.token;
    if (!token) throw new Error("Device check unavailable");
    await convexCall(
      convexURL!,
      "mutation",
      "devices:bind",
      { secret },
      signal,
      token,
    );
  }
  const transient = {
    kind: "transient",
    message: "Session service unavailable",
  } as const;
  const service: SessionService = {
    async check(signal, hinted) {
      const before = authMoment(auth);
      try {
        const result = await auth.getSession({
          fetchOptions: { signal, throw: false },
        });
        if (signal.aborted || result.error) return transient;
        const secret = convexURL ? deviceSecret() : null;
        if (result.data) {
          const accountId = result.data.user.id;
          if (!secret) return { kind: "ready", accountId };
          const known = (await deviceStatus(convexURL!, secret, signal)).find(
            (entry) => entry.accountId === accountId,
          );
          if (known && !known.revoked) return { kind: "ready", accountId };
          // New to this browser, or holding copies from before a password
          // reset: record that it is current before this account's copies
          // can appear here; old copies are then cleared as revoked (D98).
          // An interrupted clear resumes after reload (pending cleanup).
          await bindDevice(secret, signal);
          if (signal.aborted || superseded(auth, before)) return transient;
          return known?.revoked
            ? { kind: "revoked", accountId }
            : { kind: "ready", accountId };
        }
        // No session. Only a server answer that this browser's copies of the
        // account predate a reset revokes it; otherwise it is plain expiry.
        if (!hinted || !secret) return { kind: "expired" };
        const entry = (await deviceStatus(convexURL!, secret, signal)).find(
          (candidate) => candidate.accountId === hinted,
        );
        // A newer sign-in or sign-out meanwhile (in any tab) outranks this answer.
        if (signal.aborted || superseded(auth, before)) return transient;
        return entry?.revoked
          ? { kind: "revoked", accountId: hinted }
          : { kind: "expired" };
      } catch {
        return transient;
      }
    },
    async signOut(signal) {
      const result = await auth.signOut({
        fetchOptions: { signal, throw: false },
      });
      if (result.error) throw new Error("Remote sign-out unavailable");
    },
  };
  return { auth, service };
}

export type AuthClient = ReturnType<typeof createAuthService>["auth"];

/**
 * Advanced by the cross-domain client (patches/@convex-dev__better-auth) when
 * any tab starts a sign-in or sign-out.
 */
const INTENT_KEY = "better-auth_session_generation";

/** Where this device's sign-in stood at one moment, across tabs. Never logged. */
export interface AuthMoment {
  intent: string;
  credential: string;
}

export function authMoment(auth: AuthClient): AuthMoment {
  let intent = "";
  try {
    intent = localStorage.getItem(INTENT_KEY) ?? "";
  } catch {
    // Without storage there is no cross-tab state to compare.
  }
  const token = auth
    .getCookie()
    .split("; ")
    .find((part) =>
      part.slice(0, part.indexOf("=")).endsWith(".session_token"),
    );
  // A cleared session is stored as an empty value, not removed.
  const credential = token?.slice(token.indexOf("=") + 1) ?? "";
  return { intent, credential };
}

/**
 * Whether another sign-in or sign-out happened since `before`: a newer intent
 * from any tab, or a different session stored. A dead session being cleared
 * is not a new sign-in.
 */
export function superseded(auth: AuthClient, before: AuthMoment): boolean {
  const now = authMoment(auth);
  return (
    now.intent !== before.intent ||
    (now.credential !== "" && now.credential !== before.credential)
  );
}
