/**
 * Runs a write that started in one session only while that session holds
 * (History review round 6, R6-1). The app's Convex client is shared by every
 * sign-in on the device, so a write prepared for one account could otherwise
 * go out, or be answered, after another has signed in. `current` is App's
 * session ticket for the account and session the write started in. It is
 * checked before preparing, again after preparing (loading modules, reading
 * the document) right before the write is dispatched, and once more when it
 * is answered, so the caller can leave the screen alone if the session moved
 * on. The write also names its account, which the server checks, for a write
 * already on its way when the session changes.
 */
export type SessionOutcome<R> =
  { sent: false } | { sent: true; result: R; current: boolean };

export async function inSession<P, R>(
  current: () => boolean,
  prepare: () => Promise<P | null>,
  dispatch: (prepared: P) => Promise<R>,
): Promise<SessionOutcome<R>> {
  if (!current()) return { sent: false };
  const prepared = await prepare();
  if (prepared === null || !current()) return { sent: false };
  const result = await dispatch(prepared);
  return { sent: true, result, current: current() };
}
