import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

const providers: AuthConfig["providers"] = [getAuthConfigProvider()];
// Agents: the MCP Worker signs short-lived ES256 JWTs naming the agent and its
// connection. Convex verifies them with this public key; every call still checks
// that the connection is active.
if (process.env.AGENT_JWT_ISSUER && process.env.AGENT_JWT_JWKS)
  providers.push({
    type: "customJwt",
    issuer: process.env.AGENT_JWT_ISSUER,
    applicationID: "palladian-convex",
    algorithm: "ES256",
    jwks: process.env.AGENT_JWT_JWKS,
  });
export default { providers } satisfies AuthConfig;
