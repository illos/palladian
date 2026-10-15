/** Deployment configuration, validated wherever it is read. */
export function requireFrontendOrigin(value: string | undefined): string {
  if (!value) throw new Error("SITE_URL is not configured.");
  const origin = new URL(value);
  if (
    origin.origin !== value ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
      ))
  )
    throw new Error("SITE_URL must be an exact HTTPS origin.");
  return value;
}

export function requireAuthSecret(value: string | undefined): string {
  if (!value || value.length < 32)
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
  return value;
}

/** Issuer of the short-lived JWTs the MCP Worker mints for agents. */
export function agentIssuer(): string | null {
  return process.env.AGENT_JWT_ISSUER || null;
}
