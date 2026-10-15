import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConvexProvider, useMutation, useQuery } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import type { createAuthService } from "./auth-service";
import { transportError } from "./live";
import { liveStateSource, type LiveBox } from "./liveBox";
import type { SessionController } from "./session";
import { SignIn } from "./SignIn";

type Connection = ReturnType<typeof createAuthService>;
interface PageProps {
  session: SessionController;
  connection: Connection;
  liveBox: LiveBox;
}

function useLive(liveBox: LiveBox) {
  const live = useSyncExternalStore(liveBox.subscribe, liveBox.get);
  const source = useMemo(() => liveStateSource(live), [live]);
  const state = useSyncExternalStore(source.subscribe, source.get);
  return { live, state };
}

function Page({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="standalone-page">
      <div className="standalone-card">
        <div className="wordmark">palladian</div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

interface RequestInfo {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectHost: string;
  scopes: string[];
}

function ConsentForm({
  requestKey,
  info,
}: {
  requestKey: string;
  info: RequestInfo;
}) {
  const notebooks = useQuery(api.library.notebooks, {});
  const agents = useQuery(api.connections.mine, {});
  const approve = useMutation(api.connections.approve);
  const owned = (notebooks ?? []).filter((n) => n.role === "owner");
  const matching = (agents ?? []).filter(
    (a) => a.clientName === info.clientName,
  );
  const [agentChoice, setAgentChoice] = useState<string>("new");
  const [agentName, setAgentName] = useState(info.clientName.slice(0, 60));
  const [roles, setRoles] = useState<Record<string, "none" | "read" | "edit">>(
    {},
  );
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (matching.length && agentChoice === "new")
      setAgentChoice(matching[0]!.agentId);
  }, [matching.length]);
  const existing = matching.find((a) => a.agentId === agentChoice);
  const roleFor = (id: string, isDefault: boolean) => {
    if (roles[id]) return roles[id]!;
    if (existing)
      return (
        existing.notebooks.find((n) => n.notebookId === id)?.role ?? "none"
      );
    return isDefault ? "edit" : "none";
  };

  async function decide(allow: boolean) {
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, string> = { request: requestKey };
      let path = "/oauth/deny";
      if (allow) {
        const result = await approve({
          requestKey,
          clientId: info.clientId,
          clientName: info.clientName.slice(0, 100),
          redirectHost: info.redirectHost,
          agentName: agentName.trim() || info.clientName.slice(0, 60),
          ...(existing ? { agentId: existing.agentId } : {}),
          notebooks: owned
            .map((n) => ({
              notebookId: n.id,
              role: roleFor(n.id, n.isDefault),
            }))
            .filter(
              (
                n,
              ): n is { notebookId: Id<"notebooks">; role: "read" | "edit" } =>
                n.role !== "none",
            ),
          ...(later ? { autoShareRole: "edit" as const } : {}),
        });
        body = { request: requestKey, code: result.code };
        path = "/oauth/approve";
      }
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || !payload.redirectTo)
        throw new Error(
          payload.error ?? "The authorization could not be completed.",
        );
      location.assign(payload.redirectTo);
    } catch (failure) {
      setError(
        failure instanceof Error && !("data" in failure)
          ? failure.message
          : transportError(failure).message,
      );
      setBusy(false);
    }
  }

  const sharedCount = owned.filter(
    (n) => roleFor(n.id, n.isDefault) !== "none",
  ).length;
  return (
    <form
      className="stacked-form consent"
      onSubmit={(event) => {
        event.preventDefault();
        void decide(true);
      }}
    >
      <p>
        <strong>{info.clientName}</strong> wants to use your notes. After you
        allow it, you will return to <strong>{info.redirectHost}</strong>.
      </p>
      <p className="muted">
        The agent can only see notebooks you share with it below. You can change
        this or disconnect it at any time in Settings.
      </p>
      {matching.length > 0 && (
        <label>
          Agent
          <select
            value={agentChoice}
            onChange={(e) => setAgentChoice(e.target.value)}
          >
            {matching.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                Reconnect {agent.name} (keeps its access)
              </option>
            ))}
            <option value="new">A new agent</option>
          </select>
        </label>
      )}
      {!existing && (
        <label>
          Name this agent
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={60}
            required
          />
        </label>
      )}
      <fieldset>
        <legend>Notebooks this agent can use</legend>
        {notebooks === undefined && <p>Loading…</p>}
        {owned.map((notebook) => (
          <label key={notebook.id} className="consent-notebook">
            <span>{notebook.name}</span>
            <select
              aria-label={`Access to ${notebook.name}`}
              value={roleFor(notebook.id, notebook.isDefault)}
              onChange={(e) =>
                setRoles((current) => ({
                  ...current,
                  [notebook.id]: e.target.value as "none" | "read" | "edit",
                }))
              }
            >
              <option value="none">No access</option>
              <option value="read">Can read</option>
              <option value="edit">Can read and edit</option>
            </select>
          </label>
        ))}
      </fieldset>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={later}
          onChange={(e) => setLater(e.target.checked)}
        />
        Also share notebooks I create later
      </label>
      {sharedCount === 0 && !later && (
        <p className="muted">
          With no notebooks shared, the agent will not see any notes.
        </p>
      )}
      <div className="button-row">
        <button type="submit" disabled={busy || notebooks === undefined}>
          Allow
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          Deny
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

export function ConnectPage({ session, connection, liveBox }: PageProps) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { live, state } = useLive(liveBox);
  const requestKey = new URLSearchParams(location.search).get("request") ?? "";
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    session.start();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) {
      setFailed(true);
      return;
    }
    void fetch("/oauth/request/" + requestKey)
      .then((response) =>
        response.ok ? (response.json() as Promise<RequestInfo>) : null,
      )
      .then((value) => (value ? setInfo(value) : setFailed(true)))
      .catch(() => setFailed(true));
  }, []);
  if (failed)
    return (
      <Page title="Connection request expired">
        <p>
          Start connecting again from your agent. Requests expire after ten
          minutes.
        </p>
      </Page>
    );
  if (!info)
    return (
      <Page title="Connect an agent">
        <p>Loading…</p>
      </Page>
    );
  if (snapshot.status !== "ready" || !live || !state.ready)
    return (
      <Page title={`Connect ${info.clientName}`}>
        <p>Sign in to choose what {info.clientName} can access.</p>
        {snapshot.status === "connecting" || snapshot.status === "retrying" ? (
          <p className="muted">Connecting…</p>
        ) : (
          <SignIn connection={connection} session={session} inline />
        )}
      </Page>
    );
  return (
    <Page title={`Connect ${info.clientName}`}>
      <ConvexProvider client={live.client}>
        <ConsentForm requestKey={requestKey} info={info} />
      </ConvexProvider>
    </Page>
  );
}

function InviteBody({
  token,
  session,
  connection,
  liveBox,
}: PageProps & { token: string }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { live, state } = useLive(liveBox);
  const preview = useQuery(api.invitations.preview, { token });
  const acceptExisting = useMutation(api.invitations.acceptExisting);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done && snapshot.status === "ready") location.replace("/");
  }, [done, snapshot.status]);
  if (preview === undefined) return <p>Loading…</p>;
  if (preview === null) return <p>This invitation link is not valid.</p>;
  if (preview.status !== "open" || preview.expiresAt < Date.now())
    return (
      <p>
        This invitation{" "}
        {preview.status === "used"
          ? "was already used"
          : preview.status === "revoked"
            ? "was withdrawn"
            : "has expired"}
        .
        {preview.status === "used" && (
          <>
            {" "}
            <a href="/">Open Palladian</a>
          </>
        )}
      </p>
    );
  const offer = preview.target
    ? `${preview.inviterName ?? "Someone"} invited ${preview.email} to “${preview.target}”.`
    : `Set up your Palladian account for ${preview.email}.`;
  if (preview.accountExists) {
    if (snapshot.status !== "ready" || !state.ready || !live)
      return (
        <>
          <p>{offer}</p>
          <p className="muted">Sign in with {preview.email} to accept.</p>
          <SignIn connection={connection} session={session} inline />
        </>
      );
    return (
      <>
        <p>{offer}</p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void acceptExisting({ token })
              .then(() => location.replace("/"))
              .catch((failure: unknown) => {
                setError(transportError(failure).message);
                setBusy(false);
              });
          }}
        >
          Accept invitation
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </>
    );
  }
  return (
    <form
      className="stacked-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (password !== confirm) {
          setError("The passwords do not match.");
          return;
        }
        if (!live) return;
        setBusy(true);
        setError(null);
        void live.client
          .action(api.invitations.accept, { token, name, password })
          .then(async ({ email }) => {
            const result = await connection.auth.signIn.email({
              email,
              password,
            });
            if (result.error)
              throw new Error("Your account was created. Sign in to continue.");
            setDone(true);
            session.retry({ afterSignIn: true });
          })
          .catch((failure: unknown) => {
            setError(
              failure instanceof Error && !("data" in failure)
                ? failure.message
                : transportError(failure).message,
            );
            setBusy(false);
          });
      }}
    >
      <p>{offer}</p>
      <label>
        Your name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoComplete="name"
        />
      </label>
      <label>
        Email
        <input value={preview.email} readOnly autoComplete="username" />
      </label>
      <label>
        Choose a password{" "}
        <span className="muted">(at least 12 characters)</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          maxLength={128}
          required
          autoComplete="new-password"
        />
      </label>
      <label>
        Confirm password
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={12}
          maxLength={128}
          required
          autoComplete="new-password"
        />
      </label>
      <button disabled={busy}>
        {busy ? "Creating your account…" : "Create account"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

export function InvitePage(props: PageProps) {
  const { live } = useLive(props.liveBox);
  const token = location.hash.slice(1);
  useEffect(() => {
    props.session.start();
  }, []);
  return (
    <Page title="Welcome to Palladian">
      {!/^[A-Za-z0-9_-]{20,100}$/.test(token) ? (
        <p>This invitation link is not valid.</p>
      ) : live ? (
        <ConvexProvider client={live.client}>
          <InviteBody {...props} token={token} />
        </ConvexProvider>
      ) : (
        <p>Loading…</p>
      )}
    </Page>
  );
}
