import { createAuthClient } from "better-auth/react";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
export const authClient = createAuthClient({
  baseURL: __PALLADIAN_CONFIG__.authUrl,
  plugins: [
    convexClient(),
    crossDomainClient({ storagePrefix: "palladian", disableCache: true }),
  ],
});
