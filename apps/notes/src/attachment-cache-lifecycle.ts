import { useEffect } from "react";
import { attachmentCache, type AttachmentCache } from "./attachment-cache";
import {
  browserAccountHints,
  type AccountHintStore,
  type SessionController,
} from "./session";

/** The shared account hint `browserAccountHints` keeps (session.ts). */
export const ACCOUNT_HINT_KEY = "palladian.notes.account-hint.v1";

type Session = Pick<SessionController, "getSnapshot" | "subscribe">;

/**
 * Keep the attachment byte cache to the account this page may show (B3,
 * D28; review round 1, F1). Every page that owns a session installs it:
 * the notes app, and the connect, invitation and reset pages, any of which
 * can sign out, see a revoked session or switch accounts.
 *
 * It follows what every page has:
 * - the session: bytes are kept only for its account while it may be
 *   shown, the rule the notes cache follows;
 * - the shared account hint, which the session writes before any clear
 *   (sign-out and revocation set `signedOut`, a switch sets
 *   `pendingCleanup`), here and, through `storage` events, in other tabs.
 *   An account it names for cleanup is cleared even before this page's
 *   session has caught up, and on the next start if a clear was cut short.
 *
 * The cache itself keeps a failed clear pending and retries it; reads of
 * that account stay refused meanwhile.
 */
export function followAttachmentCache(
  session: Session,
  options: {
    cache?: AttachmentCache;
    hints?: AccountHintStore;
    events?: Pick<Window, "addEventListener" | "removeEventListener">;
  } = {},
): () => void {
  const cache = options.cache ?? attachmentCache;
  const events = options.events ?? window;
  let hints = options.hints;
  const read = () => {
    try {
      hints ??= browserAccountHints(localStorage);
      return hints.read();
    } catch {
      return { accountId: null, signedOut: false, pendingCleanup: null };
    }
  };
  let kept: string | null | undefined;
  let cleaning: string | null = null;
  const apply = () => {
    const snapshot = session.getSnapshot();
    const hint = read();
    const cleanup = hint.pendingCleanup ?? null;
    const permitted =
      snapshot.accountId !== null &&
      snapshot.status !== "revoked" &&
      snapshot.status !== "signed-out";
    const keep =
      permitted && !hint.signedOut && cleanup !== snapshot.accountId
        ? snapshot.accountId
        : null;
    // Failures stay pending in the cache, which retries them.
    if (cleanup && cleanup !== cleaning)
      void cache.forget(cleanup).catch(() => undefined);
    cleaning = cleanup;
    if (keep !== kept) void cache.retain(keep).catch(() => undefined);
    kept = keep;
  };
  apply();
  const stop = session.subscribe(apply);
  const changed = (event: StorageEvent) => {
    if (event.key === ACCOUNT_HINT_KEY || event.key === null) apply();
  };
  events.addEventListener("storage", changed);
  return () => {
    stop();
    events.removeEventListener("storage", changed);
  };
}

/** `followAttachmentCache` for a page component. */
export function useAttachmentCache(session: Session) {
  useEffect(() => followAttachmentCache(session), [session]);
}
