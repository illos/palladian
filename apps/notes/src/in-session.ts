/**
 * Runs a write that started in one session only while that session holds
 * (History review round 6, R6-1). The app's Convex client is shared by every
 * sign-in on the device, so a write prepared for one account could otherwise
 * go out after another has signed in. `current` is App's session ticket for
 * the account and session the write started in. It is checked before
 * preparing, and again after preparing (loading modules, reading the
 * document) right before the write is dispatched. The write also names its
 * account, which the server checks, for a write already on its way when the
 * session changes.
 */
export type SessionOutcome<R> = { sent: false } | { sent: true; result: R };

export async function inSession<P, R>(
  current: () => boolean,
  prepare: () => Promise<P | null>,
  dispatch: (prepared: P) => Promise<R>,
): Promise<SessionOutcome<R>> {
  if (!current()) return { sent: false };
  const prepared = await prepare();
  if (prepared === null || !current()) return { sent: false };
  return { sent: true, result: await dispatch(prepared) };
}

/** A copy's outcome, whatever the session: made, not sent, or failed. */
export type CopyOutcome<R> = SessionOutcome<R> | { failure: unknown };

/** What a copy changes on the screen, in the session it started in only. */
export interface CopyScreen<R> {
  /** The copy was made; `open` opens it, while the session holds. */
  made: (result: R, open: () => void) => void;
  failed: (failure: unknown) => void;
}

/**
 * A copy (Duplicate, Restore as a new note) made in the session it started
 * in, and shown only there (History review rounds 6 and 7). It is prepared
 * and sent only while `current` holds (`inSession`). Each change to the
 * screen afterwards is made only if `current()` holds at that moment,
 * checked synchronously right before it with no await in between: `made` or
 * `failed`, and the Open that `made` offers, which may be pressed long after.
 * Nothing is thrown. The outcome is returned whatever the session, for the
 * caller's bookkeeping only, which must not change the screen.
 */
export async function copyInSession<P, R>(
  current: () => boolean,
  prepare: () => Promise<P | null>,
  dispatch: (prepared: P) => Promise<R>,
  open: (result: R) => void,
  screen: CopyScreen<R>,
): Promise<CopyOutcome<R>> {
  let outcome: SessionOutcome<R>;
  try {
    outcome = await inSession(current, prepare, dispatch);
  } catch (failure) {
    if (current()) screen.failed(failure);
    return { failure };
  }
  if (outcome.sent && current()) {
    const result = outcome.result;
    screen.made(result, () => {
      if (current()) open(result);
    });
  }
  return outcome;
}

/**
 * Whether the server answered a copy: it was made, or refused. A refusal is
 * an application error with a code (`ConvexError`), which commits nothing.
 * Anything else (not sent, no answer, a failure before sending) is not an
 * answer, so the copy's creation key stays for the retry.
 */
export function serverAnswered(outcome: CopyOutcome<unknown>): boolean {
  if (!("failure" in outcome)) return outcome.sent;
  const data = (outcome.failure as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string";
}
