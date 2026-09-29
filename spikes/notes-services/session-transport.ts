/** Authentication is a background lane. Cached notes must render before calling this. */
import { createAuthClient } from "better-auth/react";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
export type SessionCheck =
  | { kind: "ready"; accountId: string }
  | { kind: "expired" }
  | { kind: "revoked"; accountId: string }
  | { kind: "transient"; message: string };
export function createSessionTransport(siteURL: string) {
  const auth = createAuthClient({
    baseURL: siteURL,
    plugins: [convexClient(), crossDomainClient()],
  });
  return {
    auth,
    async check(signal: AbortSignal): Promise<SessionCheck> {
      try {
        const result = await auth.getSession({
          fetchOptions: { signal, throw: false },
        });
        if (signal.aborted)
          return { kind: "transient", message: "Session check cancelled" };
        if (result.error)
          return {
            kind: "transient",
            message: "Session service temporarily unavailable",
          };
        if (!result.data) return { kind: "expired" };
        return { kind: "ready", accountId: result.data.user.id };
      } catch {
        return {
          kind: "transient",
          message: "Session service temporarily unavailable",
        };
      }
    },
  };
}
// A null/401 response is deliberately not labelled revoked. Known revocation needs
// a separately authenticated device-revocation signal; absence cannot prove why
// the session disappeared. Transport failures never clear local credentials.
