import { createAuthClient } from "better-auth/react";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import type { SessionService } from "./session";

/** The official client owns credentials; the notes display never awaits this module. */
export function createAuthService(siteURL: string) {
  const auth = createAuthClient({
    baseURL: siteURL,
    plugins: [convexClient(), crossDomainClient()],
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
