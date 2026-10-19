import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionService } from "./session";

/** The official client owns credentials; the notes display never awaits this module. */
export function createAuthService(siteURL: string) {
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
        if (!result.data) return { kind: "expired" };
        return { kind: "ready", accountId: result.data.user.id };
      } catch {
        return { kind: "transient", message: "Session service unavailable" };
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
