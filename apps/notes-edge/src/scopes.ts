/**
 * Scope policy. Content access is decided by notebook and note sharing in
 * Convex, not by OAuth scopes, so scopes only have to let every client sign in:
 *
 * - `notes` is the one advertised resource scope (the protected resource's
 *   `scopes_supported` and the `401` challenge), so conforming MCP clients
 *   request exactly it. It means "act as this agent"; it grants no content.
 * - `offline_access` is accepted for clients that ask for refresh tokens that
 *   way; refresh tokens are issued either way.
 * - Every grant carries `notes`, whatever was requested (nothing, unknown
 *   scopes, or a subset), so requesting no scope succeeds and later token or
 *   refresh requests naming `notes` can never fail as `invalid_scope`.
 */
export const NOTES_SCOPE = "notes";
export const OFFLINE_SCOPE = "offline_access";
export const SCOPES_SUPPORTED = [NOTES_SCOPE, OFFLINE_SCOPE];
export const REQUIRED_SCOPES = [NOTES_SCOPE];

export function grantedScopes(requested: readonly string[]): string[] {
  return requested.includes(OFFLINE_SCOPE)
    ? [NOTES_SCOPE, OFFLINE_SCOPE]
    : [NOTES_SCOPE];
}
