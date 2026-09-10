import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { authClient } from "./client";
export default function Account({ logout }: { logout: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const sessions = useQuery(api.platform.sessions.list, { cursor });
  const revoke = useAction(api.platform.sessions.revoke);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <section aria-label="Account">
      <h3>Device sessions</h3>
      <p>
        Disposable development account. Recovery and optional TOTP are not
        available. Use development data only.
      </p>
      {sessions?.page.map((s) => (
        <div key={s.id}>
          <span>
            {s.current ? "This session" : "Other session"} · Created{" "}
            {new Date(s.createdAt).toLocaleDateString()} · Expires{" "}
            {new Date(s.expiresAt).toLocaleDateString()}
          </span>{" "}
          <button
            onClick={() => {
              void revoke({ id: s.id })
                .then(() => {
                  if (!mounted.current) return;
                  if (s.current) {
                    authClient.updateSession();
                    logout();
                  }
                })
                .catch(() => {
                  if (mounted.current)
                    setMessage(
                      "Could not revoke. Retry; a fresh sign-in may be required for this account action.",
                    );
                });
            }}
          >
            Revoke
          </button>
        </div>
      ))}
      {sessions && !sessions.isDone && (
        <button onClick={() => setCursor(sessions.continueCursor)}>
          Next sessions
        </button>
      )}
      {cursor && (
        <button onClick={() => setCursor(null)}>First sessions</button>
      )}
      <p role="status">{message}</p>
      <button onClick={logout}>Sign out</button>
    </section>
  );
}
