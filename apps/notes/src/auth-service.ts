import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionService } from "./session";

const BEGAN_KEY = "palladian.notes.session-began.v1";

interface Began {
  accountId: string;
  at: number;
}

/** When this device's session began; compared with password resets (D98). */
export const sessionBegan = {
  read(): Began | null {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(BEGAN_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        "accountId" in value &&
        "at" in value &&
        typeof value.accountId === "string" &&
        typeof value.at === "number" &&
        Number.isFinite(value.at)
      )
        return { accountId: value.accountId, at: value.at };
    } catch {
      // Unreadable: no comparison is possible.
    }
    return null;
  },
  write(value: Began): void {
    try {
      localStorage.setItem(BEGAN_KEY, JSON.stringify(value));
    } catch {
      // Without storage the device cannot learn of resets; it keeps expiry behaviour.
    }
  },
  forget(): void {
    try {
      localStorage.removeItem(BEGAN_KEY);
    } catch {
      // Nothing stored.
    }
  },
};

/** Whether the account's password was reset after this device signed in. */
async function resetSince(
  convexURL: string,
  began: Began,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(`${convexURL}/api/query`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "account:resetSince",
      args: { accountId: began.accountId, since: began.at },
      format: "json",
    }),
  });
  if (!response.ok) throw new Error("Revocation check unavailable");
  const body = (await response.json()) as { status?: unknown; value?: unknown };
  if (body.status !== "success" || typeof body.value !== "boolean")
    throw new Error("Revocation check unavailable");
  return body.value;
}

/** The official client owns credentials; the notes display never awaits this module. */
export function createAuthService(siteURL: string, convexURL?: string) {
  const auth = createAuthClient({
    baseURL: siteURL,
    plugins: [convexClient(), crossDomainClient(), passkeyClient()],
  });
  const service: SessionService = {
    async check(signal) {
      try {
        const result = await auth.getSession({
          fetchOptions: { signal, throw: false },
        });
        if (signal.aborted || result.error)
          return { kind: "transient", message: "Session service unavailable" };
        if (result.data) {
          const at = new Date(result.data.session.createdAt).getTime();
          if (Number.isFinite(at))
            sessionBegan.write({ accountId: result.data.user.id, at });
          return { kind: "ready", accountId: result.data.user.id };
        }
        // No session. A password reset since this device signed in revokes
        // it (D98); anything else is ordinary expiry. Only an answer from
        // the server decides: a failed check is retried, never a revocation.
        const began = sessionBegan.read();
        if (!began || !convexURL) return { kind: "expired" };
        const reset = await resetSince(convexURL, began, signal);
        if (signal.aborted)
          return { kind: "transient", message: "Session service unavailable" };
        return reset
          ? { kind: "revoked", accountId: began.accountId }
          : { kind: "expired" };
      } catch {
        return { kind: "transient", message: "Session service unavailable" };
      }
    },
    async signOut(signal) {
      sessionBegan.forget();
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
