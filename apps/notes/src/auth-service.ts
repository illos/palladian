import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionService } from "./session";

/**
 * This browser's side of the server's device records (D98), kept by the notes
 * cache: the secret lives with the copies it vouches for.
 */
export interface DeviceStore {
  secret(): Promise<string>;
  hasCopies(accountId: string): Promise<boolean>;
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

interface DeviceStatus {
  known: boolean;
  behind: boolean;
}

async function deviceStatus(
  convexURL: string,
  secret: string,
  accountId: string,
  signal: AbortSignal,
): Promise<DeviceStatus> {
  const value = await convexCall(
    convexURL,
    "query",
    "devices:status",
    { secret, accountId },
    signal,
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("known" in value) ||
    !("behind" in value) ||
    typeof value.known !== "boolean" ||
    typeof value.behind !== "boolean"
  )
    throw new Error("Device check unavailable");
  return { known: value.known, behind: value.behind };
}

/** The official client owns credentials; the notes display never awaits this module. */
export function createAuthService(
  siteURL: string,
  convexURL?: string,
  device?: DeviceStore,
) {
  const auth = createAuthClient({
    baseURL: siteURL,
    plugins: [convexClient(), crossDomainClient(), passkeyClient()],
  });
  /** The device secret, or null where the cache cannot keep one (then it keeps no copies either). */
  async function secret(): Promise<string | null> {
    if (!convexURL || !device) return null;
    try {
      return await device.secret();
    } catch {
      return null;
    }
  }
  /**
   * Whether this browser must clear the account's copies before showing it
   * again: it is behind a password reset, or unknown here (new, or its
   * identity was lost), while it still stores copies that cannot be shown to
   * postdate the last reset (D98).
   */
  async function owesClearing(
    key: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<{ owes: boolean; current: boolean }> {
    const status = await deviceStatus(convexURL!, key, accountId, signal);
    const current = status.known && !status.behind;
    if (current) return { owes: false, current };
    return { owes: await device!.hasCopies(accountId), current };
  }
  /** Record with the signed-in session that this browser holds no older copies. */
  async function bindDevice(key: string, signal: AbortSignal) {
    const result = await auth.convex.token({
      fetchOptions: { signal, throw: false },
    });
    const token = result.data?.token;
    if (!token) throw new Error("Device check unavailable");
    await convexCall(
      convexURL!,
      "mutation",
      "devices:bind",
      { secret: key },
      signal,
      token,
    );
  }
  const transient = {
    kind: "transient",
    message: "Session service unavailable",
  } as const;
  const service: SessionService = {
    async check(signal, shown) {
      const before = authMoment(auth);
      // A newer sign-in or sign-out (in any tab) outranks anything this
      // check learned; it is asked again after every wait.
      const stale = () => signal.aborted || superseded(auth, before);
      try {
        const result = await auth.getSession({
          fetchOptions: { signal, throw: false },
        });
        if (signal.aborted || result.error) return transient;
        const key = await secret();
        if (result.data) {
          const accountId = result.data.user.id;
          if (!key) return stale() ? transient : { kind: "ready", accountId };
          // The account on screen first: its copies from before a reset are
          // cleared before a switch could offer them for export.
          if (shown && shown !== accountId) {
            const previous = await owesClearing(key, shown, signal);
            if (stale()) return transient;
            if (previous.owes) return { kind: "revoked", accountId: shown };
          }
          const standing = await owesClearing(key, accountId, signal);
          if (stale()) return transient;
          // Clear first; the server hears this browser is current only once
          // no older copies remain, so a lost answer cannot skip the clear.
          if (standing.owes) return { kind: "revoked", accountId };
          if (!standing.current) {
            await bindDevice(key, signal);
            if (stale()) return transient;
          }
          return { kind: "ready", accountId };
        }
        // No session: revoked only when the server says this browser is
        // behind a reset for the account on screen and it still holds copies.
        if (!shown || !key) return { kind: "expired" };
        const status = await deviceStatus(convexURL!, key, shown, signal);
        const copies =
          status.known && status.behind && (await device!.hasCopies(shown));
        if (stale()) return transient;
        return copies
          ? { kind: "revoked", accountId: shown }
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
  return { auth, service, deviceSecret: secret };
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
