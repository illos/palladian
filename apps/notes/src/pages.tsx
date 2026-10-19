import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConvexProvider, useMutation, useQuery } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { createAuthService } from "./auth-service";
import { transportError } from "./live";
import { liveStateSource, type LiveBox } from "./liveBox";
import type { SessionController } from "./session";
import { PasswordInput, SignIn } from "./SignIn";
import { signInAfter, started } from "./sign-in-flow";

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
  /** Verified domain of a Client ID Metadata Document client; null for self-registered apps. */
  clientDomain: string | null;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scopes: string[];
}

type Choice = "none" | "read" | "edit";
const delegationText: Record<string, string> = {
  share: "change sharing",
  delete: "permanently delete notes",
  move: "move notes",
  publish: "publish notes",
};

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
  // Continuity comes only from this exact client identity, never from its name.
  const continuing = (agents ?? []).filter((agent) =>
    agent.connections.some((c) => c.clientId === info.clientId),
  );
  const others = (agents ?? []).filter(
    (agent) => !continuing.includes(agent) && !agent.disabled,
  );
  const [agentChoice, setAgentChoice] = useState<string>("new");
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [agentName, setAgentName] = useState(info.clientName.slice(0, 60));
  const [roles, setRoles] = useState<Record<string, Choice>>({});
  const [later, setLater] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (continuing.length && agentChoice === "new")
      setAgentChoice(continuing[0]!.agentId);
  }, [continuing.length]);
  const existing = (agents ?? []).find((a) => a.agentId === agentChoice);
  const transferring = !!existing && !continuing.includes(existing);
  const roleFor = (id: string, isDefault: boolean): Choice => {
    if (roles[id]) return roles[id]!;
    if (existing)
      return (
        existing.notebooks.find((n) => n.notebookId === id)?.role ?? "none"
      );
    return isDefault ? "edit" : "none";
  };
  const shareLater =
    later ?? (existing ? existing.autoShareRole !== null : false);

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
          ...(transferring ? { transfer: true } : {}),
          // Send every notebook, including "No access", so removals apply.
          notebooks: owned.map((n) => ({
            notebookId: n.id,
            role: roleFor(n.id, n.isDefault),
          })),
          autoShareRole: shareLater ? "edit" : null,
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
  const retained = existing
    ? [
        ...(existing.noteGrants
          ? [
              `access to ${existing.noteGrants} individually shared note${existing.noteGrants === 1 ? "" : "s"}`,
            ]
          : []),
        ...existing.delegations.map(
          (d) => `permission to ${delegationText[d] ?? d}`,
        ),
      ]
    : [];
  return (
    <form
      className="stacked-form consent"
      onSubmit={(event) => {
        event.preventDefault();
        if (transferring && !confirmTransfer) {
          setError("Confirm that this app should take over the agent.");
          return;
        }
        void decide(true);
      }}
    >
      <p>
        <strong>{info.clientName}</strong>{" "}
        {info.clientDomain ? (
          <span className="muted">(verified: {info.clientDomain})</span>
        ) : (
          <span className="muted">
            (name supplied by the app, not verified)
          </span>
        )}{" "}
        wants to use your notes. After you allow it, you will return to{" "}
        <strong>{info.redirectHost}</strong>.
      </p>
      {info.redirectIsLoopback && (
        <p className="error">
          This app runs on this computer. Only continue if you just started
          connecting it yourself.
        </p>
      )}
      <p className="muted">
        The agent can only see notebooks you share with it below. You can change
        this or disconnect it at any time in Settings.
      </p>
      {(continuing.length > 0 || others.length > 0) && (
        <label>
          Agent
          <select
            aria-label="Agent"
            value={agentChoice}
            onChange={(e) => {
              setAgentChoice(e.target.value);
              setRoles({});
              setLater(null);
              setConfirmTransfer(false);
            }}
          >
            {continuing.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                Reconnect {agent.name}
              </option>
            ))}
            <option value="new">A new agent</option>
            {others.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                Transfer {agent.name} to this app
              </option>
            ))}
          </select>
        </label>
      )}
      {transferring && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={confirmTransfer}
            onChange={(e) => setConfirmTransfer(e.target.checked)}
          />
          This app replaces {existing!.name}, which was connected from a
          different app. It will get everything {existing!.name} can access.
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
                  [notebook.id]: e.target.value as Choice,
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
          checked={shareLater}
          onChange={(e) => setLater(e.target.checked)}
        />
        Also share notebooks I create later
      </label>
      {retained.length > 0 && (
        <p className="muted">
          {existing!.name} also keeps {retained.join(", ")}. Change these in
          Settings → Connected agents.
        </p>
      )}
      {sharedCount === 0 && !shareLater && retained.length === 0 && (
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
  const [created, setCreated] = useState(false);
  useEffect(() => {
    if (done && snapshot.status === "ready") location.replace("/");
  }, [done, snapshot.status]);
  if (created)
    return (
      <p role="status">
        Your account was created. <a href="/">Sign in</a> with your email and
        new password to continue.
      </p>
    );
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
        const since = started(session, connection);
        void live.client
          .action(api.invitations.accept, { token, name, password })
          .then(async ({ email }) => {
            const outcome = await signInAfter(
              session,
              connection,
              since,
              email,
              password,
            );
            if (outcome !== "signed-in") {
              setCreated(true);
              return;
            }
            setDone(true);
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
      <PasswordInput
        label="Choose a password"
        hint="(at least 12 characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={12}
        maxLength={128}
        required
        autoComplete="new-password"
      />
      <PasswordInput
        label="Confirm password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        minLength={12}
        maxLength={128}
        required
        autoComplete="new-password"
      />
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

type AgentChoice = "keep" | "disconnect";

function ResetBody({
  token,
  session,
  connection,
  liveBox,
}: PageProps & { token: string }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { live } = useLive(liveBox);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // No default: the person must choose (D26).
  const [agents, setAgents] = useState<AgentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    disconnected: number;
    signingIn: boolean;
  } | null>(null);
  useEffect(() => {
    if (done?.signingIn && snapshot.status === "ready") location.replace("/");
  }, [done, snapshot.status]);
  if (done)
    return (
      <p role="status">
        Your password is changed and your other devices are signed out
        {done.disconnected > 0
          ? `; ${done.disconnected} agent connection${done.disconnected === 1 ? " was" : "s were"} disconnected`
          : ""}
        .{" "}
        {done.signingIn ? (
          "Signing you in…"
        ) : (
          <>
            <a href="/">Sign in</a> with your new password.
          </>
        )}
      </p>
    );
  return (
    <form
      className="stacked-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !live) return;
        if (password !== confirm) {
          setError("The passwords do not match.");
          return;
        }
        if (!agents) {
          setError("Choose what happens to connected AI agents.");
          return;
        }
        setBusy(true);
        setError(null);
        const since = started(session, connection);
        void live.client
          .action(api.passwords.reset, {
            token,
            newPassword: password,
            agents,
          })
          .then(async ({ email, agentsDisconnected }) => {
            const outcome = await signInAfter(
              session,
              connection,
              since,
              email,
              password,
            );
            setDone({
              disconnected: agentsDisconnected,
              signingIn: outcome === "signed-in",
            });
          })
          .catch((failure: unknown) => {
            // A refusal (expired link, short password) says why; anything else
            // may have lost the answer to a reset that did happen.
            setError(
              failure instanceof Error && "data" in failure
                ? transportError(failure).message
                : "We could not confirm the change. Try signing in with your new password; if that fails, request a new link.",
            );
            setBusy(false);
          });
      }}
    >
      <p>
        Choose a new password. Every device signed in to your account will be
        signed out.
      </p>
      <PasswordInput
        label="New password"
        hint="(at least 12 characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={12}
        maxLength={128}
        required
        autoComplete="new-password"
      />
      <PasswordInput
        label="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        minLength={12}
        maxLength={128}
        required
        autoComplete="new-password"
      />
      <fieldset className="share-scope">
        <legend>Connected AI agents</legend>
        <label className="checkbox-row">
          <input
            type="radio"
            name="agents"
            checked={agents === "keep"}
            onChange={() => setAgents("keep")}
            required
          />
          Keep them connected
        </label>
        <label className="checkbox-row">
          <input
            type="radio"
            name="agents"
            checked={agents === "disconnect"}
            onChange={() => setAgents("disconnect")}
          />
          Disconnect them (each must be approved again)
        </label>
      </fieldset>
      <button disabled={busy || !live}>
        {busy ? "Saving…" : "Set new password"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <a href="/">Back to sign in</a>
    </form>
  );
}

export function ResetPage(props: PageProps) {
  const { live } = useLive(props.liveBox);
  const token = location.hash.slice(1);
  useEffect(() => {
    props.session.start();
  }, []);
  return (
    <Page title="Choose a new password">
      {!/^[A-Za-z0-9_-]{16,100}$/.test(token) ? (
        <p>
          This reset link is not valid. <a href="/">Request a new one</a> from
          the sign-in screen.
        </p>
      ) : live ? (
        <ResetBody {...props} token={token} />
      ) : (
        <p>Loading…</p>
      )}
    </Page>
  );
}
