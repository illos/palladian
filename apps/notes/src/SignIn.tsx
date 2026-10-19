import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type InputHTMLAttributes,
} from "react";
import type { SessionController } from "./session";
import type { createAuthService } from "./auth-service";
import { passkeyCeremony } from "./sign-in-flow";
import {
  deviceName,
  passkeyAutofill,
  passkeyOffer,
  passkeysSupported,
  platformPasskeys,
  unlockName,
} from "./passkeys";

type Connection = ReturnType<typeof createAuthService>;
type View = "sign-in" | "forgot" | "sent";

/** A password field with a show/hide control. */
export function PasswordInput({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="password-field">
      <label htmlFor={id}>
        {label}
        {hint && <span className="muted"> {hint}</span>}
      </label>
      <div className="password-input">
        <input {...input} id={id} type={shown ? "text" : "password"} />
        <button
          type="button"
          className="reveal"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function failureMessage(status: number | undefined, offline: string) {
  if (status === 401 || status === 400)
    return "That email and password do not match.";
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === undefined) return offline;
  return "Sign-in failed. Try again.";
}

/**
 * Signing in. With no account on this device it fills the screen; with a
 * cached library it is a small card over the notes, which stay readable.
 * Pages (agent consent, invitations) embed it inline.
 */
export function SignIn({
  connection,
  session,
  inline = false,
}: {
  connection: Connection;
  session: SessionController;
  inline?: boolean;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [view, setView] = useState<View>("sign-in");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  const [autofill, setAutofill] = useState(false);
  const ready = snapshot.status === "ready";
  const full = !inline && snapshot.accountId === null;
  const offline = full
    ? "Unable to connect. Check your connection and try again."
    : "Unable to connect. Your cached notes remain available.";

  /** Apply a finished sign-in unless a newer session decision replaced it. */
  function finish(generation: number, passwordUsed: boolean) {
    if (session.getSnapshot().generation !== generation) return;
    if (passwordUsed) passkeyOffer.ask();
    session.retry({ afterSignIn: true });
  }

  useEffect(() => {
    void passkeyAutofill().then(setAutofill);
  }, []);

  // Offer saved passkeys in the email field's autofill while the form shows.
  useEffect(() => {
    if (!autofill || ready || view !== "sign-in") return;
    let active = true;
    let ceremony: ReturnType<typeof passkeyCeremony> | null = null;
    void session
      .settled()
      .then(() => {
        if (!active) return;
        const current = passkeyCeremony(connection, session, true);
        ceremony = current;
        return current.result.then((result) => {
          if (active && result && !result.error)
            finish(current.generation, false);
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      ceremony?.cancel();
    };
  }, [autofill, ready, view, snapshot.generation]);

  if (ready)
    return inline ? null : (
      <PasskeyOffer connection={connection} session={session} />
    );

  // A device with a cached library asks only once its session has expired;
  // while connecting or offline the notes simply stay readable.
  if (!full && !inline && snapshot.status !== "expired") return null;

  if (full && snapshot.status === "connecting")
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="wordmark">palladian</div>
          <p className="muted">Opening…</p>
        </div>
      </div>
    );

  if (!full && !inline && later)
    return (
      <button className="auth-pill" onClick={() => setLater(false)}>
        Sign in to sync
      </button>
    );

  function signInWithPassword(form: HTMLFormElement) {
    const data = new FormData(form);
    const password = data.get("password");
    if (typeof password !== "string") return;
    const generation = session.getSnapshot().generation;
    setBusy(true);
    setError(null);
    void connection.auth.signIn
      .email({ email: email.trim(), password })
      .then((result) => {
        if (session.getSnapshot().generation !== generation) return;
        if (result.error)
          setError(failureMessage(result.error.status, offline));
        else finish(generation, true);
      })
      .catch(() => {
        if (session.getSnapshot().generation === generation) setError(offline);
      })
      .finally(() => setBusy(false));
  }

  function signInWithPasskey() {
    setBusy(true);
    setError(null);
    void session
      .settled()
      .then(() => {
        const ceremony = passkeyCeremony(connection, session, false);
        return ceremony.result.then((result) => ({
          result,
          generation: ceremony.generation,
        }));
      })
      .then(({ result, generation }) => {
        if (!result || session.getSnapshot().generation !== generation) return;
        if (!result.error) finish(generation, false);
        else if (
          result.error.status === 400 &&
          /cancel/i.test(result.error.message ?? "")
        )
          setError(null);
        else if (result.error.status === undefined) setError(offline);
        else
          setError(
            "That passkey was not recognised. Sign in with your password, then add a passkey in Settings.",
          );
      })
      .catch(() => setError(offline))
      .finally(() => setBusy(false));
  }

  function requestReset() {
    setBusy(true);
    setError(null);
    void session
      .settled()
      .then(() => connection.auth.requestPasswordReset({ email: email.trim() }))
      .then((result) => {
        if (result.error?.status === 429)
          setError("Too many requests. Wait a few minutes and try again.");
        else if (result.error) setError("The request failed. Try again.");
        else setView("sent");
      })
      .catch(() => setError(offline))
      .finally(() => setBusy(false));
  }

  let body: React.ReactNode;
  if (view === "sent")
    body = (
      <div className="auth-form">
        <p>
          If an account exists for <strong>{email.trim()}</strong>, a reset link
          is on its way. It works once, for one hour.
        </p>
        <button
          type="button"
          className="link-button"
          onClick={() => setView("sign-in")}
        >
          Back to sign in
        </button>
      </div>
    );
  else if (view === "forgot")
    body = (
      <form
        className="auth-form"
        aria-label="Reset password"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) requestReset();
        }}
      >
        <p className="muted">
          Enter your account’s email and we will send a link to choose a new
          password. Resetting signs out your other devices.
        </p>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Sending…" : "Email me a reset link"}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setError(null);
            setView("sign-in");
          }}
        >
          Back to sign in
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    );
  else
    body = (
      <form
        className="auth-form"
        aria-label="Sign in"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) signInWithPassword(event.currentTarget);
        }}
      >
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="username webauthn"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="current-password"
          required
        />
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {passkeysSupported() && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={signInWithPasskey}
          >
            Sign in with a passkey
          </button>
        )}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setError(null);
            setView("forgot");
          }}
        >
          Forgot password?
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    );

  if (inline) return <div className="sign-in inline">{body}</div>;
  if (full)
    return (
      <div className="auth-screen">
        <main className="auth-card" aria-labelledby="auth-title">
          <div className="wordmark">palladian</div>
          <h1 id="auth-title">
            {view === "sign-in" ? "Sign in" : "Reset your password"}
          </h1>
          {snapshot.status === "revoked" && view === "sign-in" && (
            <p className="muted">This device was signed out.</p>
          )}
          {body}
          <p className="auth-foot">
            Palladian is invite-only. To join, open the invitation link someone
            sent you.
          </p>
        </main>
      </div>
    );
  return (
    <section className="sign-in reconnect" aria-labelledby="reconnect-title">
      <header>
        <h2 id="reconnect-title">
          {view === "sign-in" ? "Sign in to sync" : "Reset your password"}
        </h2>
        <button
          type="button"
          className="link-button"
          onClick={() => setLater(true)}
        >
          Later
        </button>
      </header>
      {view === "sign-in" && (
        <p className="muted">Your notes on this device stay available.</p>
      )}
      {body}
    </section>
  );
}

/** After a password sign-in, offer once to add a passkey on this device. */
function PasskeyOffer({
  connection,
  session,
}: {
  connection: Connection;
  session: SessionController;
}) {
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountId = useSyncExternalStore(
    session.subscribe,
    () => session.getSnapshot().accountId,
  );
  useEffect(() => {
    if (!accountId || !passkeyOffer.pending()) return;
    let active = true;
    void (async () => {
      if (!(await platformPasskeys())) return passkeyOffer.settle();
      const listed = await connection.auth.passkey.listUserPasskeys();
      if (!active) return;
      // Passkeys sync between someone's devices; one is enough to skip the offer.
      if (listed.error) return;
      if (listed.data.length > 0) return passkeyOffer.settle();
      setShown(true);
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [accountId]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setShown(false), 5000);
    return () => clearTimeout(timer);
  }, [done]);
  if (!shown) return null;
  const unlock = unlockName();
  return (
    <section className="sign-in auth-toast" aria-labelledby="offer-title">
      {done ? (
        <p id="offer-title" role="status">
          Passkey added. Next time, choose “Sign in with a passkey”.
        </p>
      ) : (
        <>
          <h2 id="offer-title">
            {unlock
              ? `Sign in with ${unlock} next time?`
              : "Use a passkey next time?"}
          </h2>
          <p className="muted">
            A passkey replaces your password on this device. You can manage
            passkeys in Settings → Account.
          </p>
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void connection.auth.passkey
                  .addPasskey({ name: deviceName() })
                  .then((result) => {
                    if (result.error) {
                      if (!/cancel/i.test(result.error.message ?? ""))
                        setError(
                          "The passkey could not be added. Try again in Settings.",
                        );
                      return;
                    }
                    passkeyOffer.settle();
                    setDone(true);
                  })
                  .catch(() =>
                    setError("Unable to connect. Try again in Settings."),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Set up passkey
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                passkeyOffer.settle();
                setShown(false);
              }}
            >
              Not now
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
