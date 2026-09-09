import { Component, lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ConvexReactClient,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { api } from "../../../../convex/_generated/api";
import { authClient } from "./client";
import { record, exportDiagnostics } from "./diagnostics";
const SignIn = lazy(() => import("./SignIn"));
const Account = lazy(() => import("./Account"));
function Identity({
  reset,
  logout,
}: {
  reset: () => void;
  logout: () => void;
}) {
  const ensure = useMutation(api.platform.identity.ensure);
  const [mapped, setMapped] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void ensure({})
      .then(() => {
        if (active) setMapped(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [ensure]);
  const identity = useQuery(
    api.platform.identity.current,
    mapped ? {} : "skip",
  );
  useEffect(() => {
    if (identity) {
      record("ready");
      performance.mark("palladian-authenticated-data");
    }
  }, [identity]);
  if (failed)
    return (
      <p>
        Account connection needs a retry.{" "}
        <button onClick={reset}>Retry connection</button>
      </p>
    );
  if (identity === null)
    return (
      <p>
        Session no longer valid. <button onClick={reset}>Check session</button>
      </p>
    );
  if (!identity) return <p role="status">Connecting private account…</p>;
  return (
    <div key={identity.id} data-testid="private-account">
      <p>Account connected.</p>
      <Suspense fallback={<p>Opening account…</p>}>
        <Account logout={logout} />
      </Suspense>
    </div>
  );
}
function Readiness({
  reset,
  logout,
}: {
  reset: () => void;
  logout: () => void;
}) {
  const session = authClient.useSession();
  const convex = useConvexAuth();
  if (session.error)
    return (
      <p role="status">
        Connection unavailable. Your session is retained.{" "}
        <button onClick={reset}>Retry connection</button>
      </p>
    );
  if (session.isPending)
    return (
      <p role="status">
        Checking session… <button onClick={reset}>Retry connection</button>
      </p>
    );
  if (!session.data)
    return (
      <Suspense fallback={<p>Opening sign-in…</p>}>
        <SignIn done={reset} />
      </Suspense>
    );
  if (!convex.isAuthenticated)
    return (
      <p role="status">
        Connecting account… <button onClick={reset}>Retry connection</button>
      </p>
    );
  return <Identity reset={reset} logout={logout} />;
}
class ConnectionBoundary extends Component<
  { children: ReactNode; reset: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="status">
        Account connection needs checking.{" "}
        <button onClick={this.props.reset}>Retry connection</button>
      </p>
    ) : (
      this.props.children
    );
  }
}
function Connection({
  reset,
  logout,
}: {
  reset: () => void;
  logout: () => void;
}) {
  const [client] = useState(
    () =>
      new ConvexReactClient(__PALLADIAN_CONFIG__.dataUrl, { logger: false }),
  );
  useEffect(
    () => () => {
      // React runs parent cleanup before the nested auth provider cleanup.
      queueMicrotask(() => {
        void client.close();
      });
    },
    [client],
  );
  return (
    <ConvexBetterAuthProvider client={client} authClient={authClient}>
      <Readiness reset={reset} logout={logout} />
    </ConvexBetterAuthProvider>
  );
}
export default function Runtime() {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<
    "checking" | "connected" | "temporary" | "logout"
  >("checking");
  function reset() {
    setState("checking");
    setEpoch((e) => e + 1);
  }
  useEffect(() => {
    let active = true;
    record("resolving");
    void authClient
      .getSession()
      .then((result) => {
        if (!active) return;
        if (result.error) {
          record("temporary");
          setState("temporary");
        } else {
          record(result.data ? "resolving" : "sign_in_needed");
          authClient.updateSession();
          setState("connected");
        }
      })
      .catch(() => {
        if (active) {
          record("temporary");
          setState("temporary");
        }
      });
    return () => {
      active = false;
    };
  }, [epoch]);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (event.key !== "palladian_cookie") return;
      function sessionCredential(value: string | null): unknown {
        try {
          const cookies: Record<string, { value?: unknown }> = JSON.parse(
            value ?? "{}",
          );
          return Object.entries(cookies).find(([key]) =>
            key.endsWith(".session_token"),
          )?.[1].value;
        } catch {
          return null;
        }
      }
      if (
        sessionCredential(event.oldValue) !== sessionCredential(event.newValue)
      ) {
        record("account_change");
        reset();
      }
    }
    function online() {
      reset();
    }
    window.addEventListener("storage", changed);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("online", online);
    };
  }, []);
  function logout() {
    // Unmount all private subscriptions/cache before waiting for the network.
    record("logout");
    setState("logout");
    void authClient
      .signOut()
      .then((result) => {
        if (result.error) setState("logout");
        else reset();
      })
      .catch(() => setState("logout"));
  }
  return (
    <section aria-label="Authentication">
      <p>Development data only · Recovery/TOTP pending</p>
      {state === "connected" ? (
        <ConnectionBoundary key={epoch} reset={reset}>
          <Connection reset={reset} logout={logout} />
        </ConnectionBoundary>
      ) : (
        <p role="status">
          {state === "logout"
            ? "Local sign-out complete. Server revocation was not confirmed; revoke this session from another device if the connection failed."
            : state === "temporary"
              ? "Connection unavailable. Your session is retained."
              : "Checking session…"}{" "}
          <button onClick={reset}>Retry connection</button>
        </p>
      )}
      <button onClick={exportDiagnostics}>Export redacted diagnostics</button>
    </section>
  );
}
