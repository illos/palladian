import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionCheck } from "./session";

/**
 * This browser's side of the server's device records (D98), kept by the notes
 * cache: the secret lives with the copies it vouches for.
 */
export interface DeviceStore {
  secret(): Promise<string>;
  /** The account's stored lifecycle, read before asking the server. */
  lifecycle(accountId: string): Promise<number>;
  /**
   * Clear the account's copies in every tab (the cache's fenced clear, which
   * also drops other tabs' memory-only drafts). Fails, changing nothing, if
   * a tab has begun a newer lifecycle of the account since `lifecycle`.
   * `reconcile`: other tabs check their session again; `revoke`: they sign
   * the account out, as for any revocation.
   */
  clear(
    accountId: string,
    lifecycle: number,
    purpose: "reconcile" | "revoke",
  ): Promise<void>;
}

/**
 * A session check's answer, or `reconciled`: the browser has just cleared any
 * older copies of the account and recorded itself current, so the caller
 * checks again under a fresh activation fence.
 */
export type TransportCheck = SessionCheck | { kind: "reconciled" };

/** The session service as the app's boot code drives it. */
export interface AuthTransport {
  check(signal: AbortSignal, shown?: string | null): Promise<TransportCheck>;
  signOut?(signal: AbortSignal): Promise<void>;
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
  const devices = convexURL && device ? device : null;
  /**
   * Record with the signed-in session that this browser holds no copies of
   * `accountId` from before its last reset. A sign-in elsewhere while the
   * token is fetched cancels it; the server refuses a token for another
   * account.
   */
  async function bindDevice(
    key: string,
    accountId: string,
    signal: AbortSignal,
    stale: () => boolean,
  ) {
    const result = await auth.convex.token({
      fetchOptions: { signal, throw: false },
    });
    const token = result.data?.token;
    if (!token || stale()) throw new Error("Device check superseded");
    await convexCall(
      convexURL!,
      "mutation",
      "devices:bind",
      { secret: key, accountId },
      signal,
      token,
    );
  }
  const transient = {
    kind: "transient",
    message: "Session service unavailable",
  } as const;
  const service: AuthTransport = {
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
        if (result.data) {
          const accountId = result.data.user.id;
          if (!devices)
            return stale() ? transient : { kind: "ready", accountId };
          // Failing to read or create the secret proves nothing about the
          // copies here: retry rather than open (cached viewing continues).
          const key = await devices.secret();
          const switching = shown && shown !== accountId ? shown : null;
          // Lifecycles are read before the server is asked: a clear decided
          // on its answer applies only if no tab has since begun a newer one.
          const shownLifecycle = switching
            ? await devices.lifecycle(switching)
            : 0;
          const lifecycle = await devices.lifecycle(accountId);
          if (stale()) return transient;
          // The account on screen first: if this browser is behind a reset
          // for it, or unknown, its copies go before a switch could offer
          // them for export.
          if (switching) {
            const previous = await deviceStatus(
              convexURL!,
              key,
              switching,
              signal,
            );
            if (stale()) return transient;
            if (!(previous.known && !previous.behind)) {
              await devices.clear(switching, shownLifecycle, "revoke");
              if (stale()) return transient;
            }
          }
          const status = await deviceStatus(convexURL!, key, accountId, signal);
          if (stale()) return transient;
          if (status.known && !status.behind)
            return { kind: "ready", accountId };
          // Behind a reset, or unknown here (new, or its identity was lost):
          // clear the account in every tab, then tell the server this browser
          // is current, then check again under a fresh fence (D98).
          await devices.clear(accountId, lifecycle, "reconcile");
          if (stale()) return transient;
          await bindDevice(key, accountId, signal, stale);
          return stale() ? transient : { kind: "reconciled" };
        }
        // No session. Behind a reset for the account on screen: clear it in
        // every tab and report the revocation. Otherwise plain expiry.
        if (!devices || !shown)
          return stale() ? transient : { kind: "expired" };
        const key = await devices.secret();
        const lifecycle = await devices.lifecycle(shown);
        const status = await deviceStatus(convexURL!, key, shown, signal);
        if (stale()) return transient;
        if (!(status.known && status.behind)) return { kind: "expired" };
        await devices.clear(shown, lifecycle, "revoke");
        return stale() ? transient : { kind: "revoked", accountId: shown };
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
  /** For the reset page: this browser keeps its copies when it makes a reset. */
  async function deviceSecret(): Promise<string | null> {
    try {
      return devices ? await devices.secret() : null;
    } catch {
      return null;
    }
  }
  return { auth, service, deviceSecret };
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
