import { useState } from "react";
import { authClient } from "./client";
export default function SignIn({ done }: { done: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      aria-label="Sign in"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setBusy(true);
        setMessage("");
        void authClient.signIn
          .email({
            email: String(data.get("email")),
            password: String(data.get("password")),
          })
          .then((result) => {
            if (result.error)
              setMessage(
                result.error.status === 401
                  ? "Sign-in details were not accepted."
                  : "Sign-in could not finish. Retry.",
              );
            else {
              form.reset();
              done();
            }
          })
          .catch(() => setMessage("Connection unavailable. Retry."))
          .finally(() => setBusy(false));
      }}
    >
      <h3>Private owner sign-in</h3>
      <label>
        Email{" "}
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password{" "}
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <button disabled={busy}>Sign in</button>
      <p role="status">{message}</p>
    </form>
  );
}
