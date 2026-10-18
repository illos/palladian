/**
 * Sign-in work that takes time (a passkey prompt, account creation, a
 * password reset) must not finish under a different sign-in than the one it
 * began in.
 */
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import {
  authMoment,
  superseded,
  type AuthMoment,
  type createAuthService,
} from "./auth-service";
import { passkeyOffer } from "./passkeys";
import type { SessionController } from "./session";

type Connection = ReturnType<typeof createAuthService>;
type Session = Pick<SessionController, "getSnapshot" | "subscribe" | "retry">;

/** The newest passkey ceremony; only it may cancel the browser prompt. */
let activeCeremony: object | null = null;

/**
 * One passkey ceremony bound to the sign-in state it began in. Another
 * sign-in or sign-out (in this tab, another tab, or a newer session
 * decision) cancels the browser prompt and refuses the verification before
 * any session is stored. `result` is null when the ceremony was superseded.
 */
export function passkeyCeremony(
  connection: Connection,
  session: Session,
  autoFill: boolean,
) {
  const generation = session.getSnapshot().generation;
  const before = authMoment(connection.auth);
  const controller = new AbortController();
  const ceremony = {};
  activeCeremony = ceremony;
  const stale = () =>
    session.getSnapshot().generation !== generation ||
    superseded(connection.auth, before);
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new DOMException("Sign-in superseded", "AbortError"));
    if (activeCeremony === ceremony) WebAuthnAbortService.cancelCeremony();
  };
  const check = () => {
    if (stale()) cancel();
  };
  const unsubscribe = session.subscribe(check);
  window.addEventListener("storage", check);
  const stop = () => {
    unsubscribe();
    window.removeEventListener("storage", check);
  };
  const result = connection.auth.signIn
    .passkey({
      autoFill,
      fetchOptions: {
        // Linked to the cross-domain request guard: once aborted, the
        // verification response cannot store its session.
        signal: controller.signal,
        // The last check before the request that creates a session.
        onRequest: () => {
          check();
          controller.signal.throwIfAborted();
        },
      },
    })
    .finally(stop)
    .then((outcome) => (controller.signal.aborted ? null : outcome));
  return { result, generation, cancel };
}

/** Where sign-in stood when a request began. */
export interface Started {
  generation: number;
  moment: AuthMoment;
}

export function started(session: Session, connection: Connection): Started {
  return {
    generation: session.getSnapshot().generation,
    moment: authMoment(connection.auth),
  };
}

/**
 * Sign in after creating an account or resetting a password, unless another
 * sign-in or sign-out (in any tab) or a newer session decision happened since
 * the request began. Then the work stands but nobody is signed in for it.
 */
export async function signInAfter(
  session: Session,
  connection: Connection,
  since: Started,
  email: string,
  password: string,
): Promise<"signed-in" | "superseded" | "failed"> {
  const current = () =>
    session.getSnapshot().generation === since.generation &&
    !superseded(connection.auth, since.moment);
  if (!current()) return "superseded";
  const result = await connection.auth.signIn.email({ email, password });
  if (session.getSnapshot().generation !== since.generation)
    return "superseded";
  if (result.error) return "failed";
  passkeyOffer.ask();
  session.retry({ afterSignIn: true });
  return "signed-in";
}
