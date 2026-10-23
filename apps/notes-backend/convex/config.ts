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

/**
 * Whether new content may use files (B1/B2): uploads, file blocks, image
 * widths and images showing uploaded objects. Off unless the deployment sets
 * FILES_WRITES_ENABLED=true, which the owner does once every device runs an
 * app build that understands file blocks (review round 3; rollout in
 * docs/reviews/notes-files-backend-implementation.md). Reads, existing
 * content and legacy sources are unaffected.
 */
export function filesWritesEnabled(): boolean {
  return process.env.FILES_WRITES_ENABLED === "true";
}
export const FILES_DISABLED_MESSAGE =
  "Files and image sizes are not enabled on this server yet.";

/**
 * Whether owners may delete notebooks (plan 08 A5). Off unless the deployment
 * sets NOTEBOOK_DELETE_ENABLED=true. Deleting a notebook widens the D86 gap
 * for collaborators' offline drafts (sign-out export and other tabs) until the
 * sync fundamentals hold such drafts; see the "Shipping with Delete off"
 * section of docs/reviews/notes-notebooks-implementation.md.
 */
export function notebookDeleteEnabled(): boolean {
  return process.env.NOTEBOOK_DELETE_ENABLED === "true";
}
export const NOTEBOOK_DELETE_DISABLED_MESSAGE =
  "Deleting notebooks is not enabled on this server yet.";
