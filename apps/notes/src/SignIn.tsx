import { useState, useSyncExternalStore } from "react";
import type { SessionController } from "./session";
import type { createAuthService } from "./auth-service";
export function SignIn({
  connection,
  session,
}: {
  connection: ReturnType<typeof createAuthService>;
  session: SessionController;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (snapshot.status === "ready") return null;
  return (
    <form
      className="sign-in"
      aria-label="Sign in"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(event.currentTarget);
        const email = data.get("email");
        const password = data.get("password");
        if (typeof email !== "string" || typeof password !== "string") return;
        const generation = session.getSnapshot().generation;
        setBusy(true);
        setError(null);
        void connection.auth.signIn
          .email({ email, password })
          .then((result) => {
            if (session.getSnapshot().generation !== generation) return;
            if (result.error)
              setError("Sign-in failed. Check your details or try again.");
            else session.retry({ afterSignIn: true });
          })
          .catch(() => {
            if (session.getSnapshot().generation === generation)
              setError(
                "Unable to connect. Your cached notes remain available.",
              );
          })
          .finally(() => setBusy(false));
      }}
    >
      <h2>Sign in to reconnect</h2>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
