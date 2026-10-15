import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConvexProvider, useMutation, useQuery } from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import type { CachedNotebook } from "./cache";
import type { LiveController } from "./live";
import { transportError } from "./live";
import type { SessionController } from "./session";

type Panel = "agents" | "account" | "share" | "notebook";
type Role = "read" | "edit";

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(transportError(failure).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="panel-dialog"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="panel-dialog-header">
        <h2>{label}</h2>
        <button type="button" className="link-button" onClick={onClose}>
          Done
        </button>
      </header>
      {children}
    </dialog>
  );
}

function RoleSelect({
  value,
  onChange,
  allowNone,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="read">Can read</option>
      <option value="edit">Can edit</option>
      {allowNone && <option value="none">No access</option>}
      <option value="remove">Remove</option>
    </select>
  );
}

function InviteLink({ token }: { token: string }) {
  const link = `${location.origin}/invite#${token}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="invite-link">
      <p>
        Send this single-use link to the person you invited. It expires in 14
        days.
      </p>
      <input
        readOnly
        value={link}
        aria-label="Invitation link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(link)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

/** Add an existing person/agent or invite a new email. */
function AddMember({
  existing,
  onAdd,
  onInvite,
}: {
  existing: Set<string>;
  onAdd: (principalId: Id<"principals">, role: Role) => Promise<boolean>;
  onInvite: (email: string, role: Role) => Promise<string | null>;
}) {
  const candidates = useQuery(api.sharing.candidates, {}) ?? [];
  const [choice, setChoice] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("edit");
  const [token, setToken] = useState<string | null>(null);
  const available = candidates.filter((c) => !existing.has(c.principalId));
  return (
    <div className="add-member">
      {available.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!choice) return;
            void onAdd(choice as Id<"principals">, role).then((ok) => {
              if (ok) setChoice("");
            });
          }}
        >
          <select
            aria-label="Person or agent"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">Add a person or agent…</option>
            {available.map((c) => (
              <option key={c.principalId} value={c.principalId}>
                {c.kind === "agent"
                  ? `${c.name} (agent${c.controllerName ? ` of ${c.controllerName}` : ""})`
                  : `${c.name}${c.email ? ` — ${c.email}` : ""}`}
              </option>
            ))}
          </select>
          <select
            aria-label="Access"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            <option value="read">Can read</option>
            <option value="edit">Can edit</option>
          </select>
          <button disabled={!choice}>Add</button>
        </form>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim()) return;
          void onInvite(email, role).then((result) => {
            setToken(result);
            if (result !== null || result === null) setEmail("");
          });
        }}
      >
        <input
          type="email"
          placeholder="Invite by email"
          aria-label="Invite by email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button disabled={!email.trim()}>Invite</button>
      </form>
      {token && <InviteLink token={token} />}
    </div>
  );
}

function memberLabel(member: {
  name: string;
  kind: "human" | "agent";
  email: string | null;
  controllerName: string | null;
}) {
  if (member.kind === "agent")
    return `${member.name} · agent${member.controllerName ? ` of ${member.controllerName}` : ""}`;
  return member.email ? `${member.name} · ${member.email}` : member.name;
}

function ShareNote({
  noteId,
  onClose,
}: {
  noteId: Id<"notes">;
  onClose: () => void;
}) {
  const note = useQuery(api.notes.get, { noteId });
  const access = useQuery(api.sharing.noteAccess, { noteId });
  const members = useQuery(
    api.sharing.notebookMembers,
    note?.notebook ? { notebookId: note.notebook.id } : "skip",
  );
  const setRestricted = useMutation(api.sharing.setNoteRestricted);
  const setMember = useMutation(api.sharing.setNoteMember);
  const invite = useMutation(api.invitations.create);
  const { error, busy, run } = useAction();
  if (note === undefined || access === undefined)
    return (
      <Modal label="Share" onClose={onClose}>
        <p>Loading…</p>
      </Modal>
    );
  if (!note || !access)
    return (
      <Modal label="Share" onClose={onClose}>
        <p>This note is not available.</p>
      </Modal>
    );
  const canShare = access.canShare;
  const granted = new Set(access.grants.map((g) => g.principalId as string));
  return (
    <Modal
      label={`Share “${note.summary.title || "Untitled"}”`}
      onClose={onClose}
    >
      {note.notebook && (
        <fieldset className="share-scope" disabled={!canShare || busy}>
          <legend>Who can open this note</legend>
          <label>
            <input
              type="radio"
              name="scope"
              checked={!access.restricted}
              onChange={() =>
                void run(() => setRestricted({ noteId, restricted: false }))
              }
            />
            Everyone with access to {note.notebook.name}
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              checked={access.restricted}
              onChange={() =>
                void run(() => setRestricted({ noteId, restricted: true }))
              }
            />
            Only the people and agents listed below
          </label>
        </fieldset>
      )}
      {!access.restricted && members && members.length > 0 && (
        <section className="member-list">
          <h3>From the notebook</h3>
          <ul>
            {members.map((member) => (
              <li key={member.principalId}>
                <span>{memberLabel(member)}</span>
                <span className="member-role">
                  {member.role === "owner"
                    ? "Owner"
                    : member.role === "edit"
                      ? "Can edit"
                      : "Can read"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="member-list">
        <h3>Added to this note</h3>
        {access.grants.length === 0 && <p className="muted">No one yet.</p>}
        <ul>
          {access.grants.map((grant) => (
            <li key={grant.principalId}>
              <span>{memberLabel(grant)}</span>
              <RoleSelect
                label={`Access for ${grant.name}`}
                value={grant.role}
                allowNone
                disabled={!canShare || busy}
                onChange={(value) =>
                  void run(() =>
                    setMember({
                      noteId,
                      principalId: grant.principalId,
                      role:
                        value === "remove" ? null : (value as Role | "none"),
                    }),
                  )
                }
              />
            </li>
          ))}
        </ul>
      </section>
      {canShare ? (
        <AddMember
          existing={granted}
          onAdd={(principalId, role) =>
            run(() => setMember({ noteId, principalId, role }))
          }
          onInvite={async (email, role) => {
            let token: string | null = null;
            await run(async () => {
              const result = await invite({ email, noteId, role });
              token = result.kind === "invited" ? result.token : null;
            });
            return token;
          }}
        />
      ) : (
        <p className="muted">Only the owner can change sharing.</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}

function NotebookPanel({
  notebookId,
  onClose,
  onCreated,
}: {
  notebookId: Id<"notebooks"> | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useMutation(api.notebooks.create);
  const update = useMutation(api.notebooks.update);
  const setMember = useMutation(api.sharing.setNotebookMember);
  const invite = useMutation(api.invitations.create);
  const members = useQuery(
    api.sharing.notebookMembers,
    notebookId ? { notebookId } : "skip",
  );
  const notebooks = useQuery(api.library.notebooks, {});
  const notebook = notebooks?.find((n) => n.id === notebookId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { error, busy, run } = useAction();
  useEffect(() => {
    if (notebook) {
      setName(notebook.name);
      setDescription(notebook.description);
    }
  }, [notebook?.id]);
  if (!notebookId)
    return (
      <Modal label="New notebook" onClose={onClose}>
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const id = await create({ name, description });
              onCreated(id);
            });
          }}
        >
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Description{" "}
            <span className="muted">(also guides agents filing notes)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </label>
          <button disabled={busy || !name.trim()}>Create notebook</button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </Modal>
    );
  const isOwner = notebook?.role === "owner";
  const existing = new Set((members ?? []).map((m) => m.principalId as string));
  return (
    <Modal label={notebook?.name ?? "Notebook"} onClose={onClose}>
      {isOwner && (
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => update({ notebookId, name, description }));
          }}
        >
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Description{" "}
            <span className="muted">(also guides agents filing notes)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </label>
          <button disabled={busy}>Save</button>
        </form>
      )}
      <section className="member-list">
        <h3>People and agents with access</h3>
        <ul>
          {(members ?? []).map((member) => (
            <li key={member.principalId}>
              <span>{memberLabel(member)}</span>
              {member.role === "owner" || !isOwner ? (
                <span className="member-role">
                  {member.role === "owner"
                    ? "Owner"
                    : member.role === "edit"
                      ? "Can edit"
                      : "Can read"}
                </span>
              ) : (
                <RoleSelect
                  label={`Access for ${member.name}`}
                  value={member.role}
                  disabled={busy}
                  onChange={(value) =>
                    void run(() =>
                      setMember({
                        notebookId,
                        principalId: member.principalId,
                        role: value === "remove" ? null : (value as Role),
                      }),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      </section>
      {isOwner && (
        <AddMember
          existing={existing}
          onAdd={(principalId, role) =>
            run(() => setMember({ notebookId, principalId, role }))
          }
          onInvite={async (email, role) => {
            let token: string | null = null;
            await run(async () => {
              const result = await invite({ email, notebookId, role });
              token = result.kind === "invited" ? result.token : null;
            });
            return token;
          }}
        />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}

const delegationLabels = {
  share: "Change sharing on my notebooks and notes",
  delete: "Permanently delete my notes",
  move: "Move my notes between notebooks",
  publish: "Publish my notes",
} as const;

function AgentsPanel({ notebooks }: { notebooks: CachedNotebook[] }) {
  const agents = useQuery(api.connections.mine, {});
  const revoke = useMutation(api.connections.revoke);
  const updateAgent = useMutation(api.connections.updateAgent);
  const setMember = useMutation(api.sharing.setNotebookMember);
  const { error, busy, run } = useAction();
  const owned = notebooks.filter((n) => n.role === "owner");
  return (
    <div className="agents-panel">
      <section className="connect-help">
        <h3>Connect an agent</h3>
        <p>
          Add Palladian as a custom connector in Claude, ChatGPT, Claude Code or
          Codex using this address. You will sign in here and choose which
          notebooks the agent may use.
        </p>
        <code className="connector-url">{location.origin}/mcp</code>
      </section>
      {agents === undefined && <p>Loading…</p>}
      {agents?.length === 0 && (
        <p className="muted">No agents connected yet.</p>
      )}
      {agents?.map((agent) => {
        const active = agent.connections.filter((c) => c.revokedAt === null);
        const shared = new Map(
          agent.notebooks.map((n) => [n.notebookId as string, n.role]),
        );
        return (
          <section key={agent.agentId} className="agent-card">
            <header>
              <h3>{agent.name}</h3>
              <span className="muted">
                {agent.disabled
                  ? "Disabled"
                  : active.length
                    ? `${active.length} active connection${active.length > 1 ? "s" : ""}`
                    : "Not connected"}
              </span>
            </header>
            <h4>Notebooks</h4>
            <ul className="member-list">
              {owned.map((notebook) => (
                <li key={notebook.id}>
                  <span>{notebook.name}</span>
                  <select
                    aria-label={`${agent.name} access to ${notebook.name}`}
                    value={shared.get(notebook.id) ?? "none"}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        setMember({
                          notebookId: notebook.id as Id<"notebooks">,
                          principalId: agent.agentId,
                          role:
                            event.target.value === "none"
                              ? null
                              : (event.target.value as Role),
                        }),
                      )
                    }
                  >
                    <option value="none">No access</option>
                    <option value="read">Can read</option>
                    <option value="edit">Can edit</option>
                  </select>
                </li>
              ))}
            </ul>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={agent.autoShareRole !== null}
                disabled={busy}
                onChange={(event) =>
                  void run(() =>
                    updateAgent({
                      agentId: agent.agentId,
                      autoShareRole: event.target.checked ? "edit" : null,
                    }),
                  )
                }
              />
              Also share notebooks I create later
            </label>
            <h4>May also</h4>
            {(
              Object.keys(delegationLabels) as (keyof typeof delegationLabels)[]
            ).map((key) => (
              <label key={key} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={agent.delegations.includes(key)}
                  disabled={busy}
                  onChange={(event) =>
                    void run(() =>
                      updateAgent({
                        agentId: agent.agentId,
                        delegations: event.target.checked
                          ? [...agent.delegations, key]
                          : agent.delegations.filter((d) => d !== key),
                      }),
                    )
                  }
                />
                {delegationLabels[key]}
              </label>
            ))}
            <h4>Connections</h4>
            <ul className="member-list">
              {agent.connections.map((connection) => (
                <li key={connection.id}>
                  <span>
                    {connection.clientName} · {connection.redirectHost} ·{" "}
                    {new Date(connection.createdAt).toLocaleDateString()}
                  </span>
                  {connection.revokedAt === null ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() => revoke({ connectionId: connection.id }))
                      }
                    >
                      Disconnect
                    </button>
                  ) : (
                    <span className="muted">Disconnected</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

function AccountPanel({ session }: { session: SessionController }) {
  const me = useQuery(api.account.me, {});
  const rename = useMutation(api.account.rename);
  const pending = useQuery(api.invitations.pending, {});
  const revokeInvite = useMutation(api.invitations.revoke);
  const [name, setName] = useState("");
  const { error, busy, run } = useAction();
  useEffect(() => {
    if (me) setName(me.name);
  }, [me?.id]);
  return (
    <div className="account-panel">
      {me && (
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => rename({ name }));
          }}
        >
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </label>
          <p className="muted">Signed in as {me.email}</p>
          <button disabled={busy}>Save</button>
        </form>
      )}
      <section className="member-list">
        <h3>Pending invitations</h3>
        {pending?.length === 0 && <p className="muted">None.</p>}
        <ul>
          {pending?.map((invitation) => (
            <li key={invitation.id}>
              <span>
                {invitation.email} · expires{" "}
                {new Date(invitation.expiresAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => revokeInvite({ invitationId: invitation.id }))
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>
      <button type="button" onClick={() => void session.logout()}>
        Sign out
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

export default function Panels({
  live,
  panel,
  session,
  notebooks,
  noteId,
  notebookId,
  onClose,
  onNotebookCreated,
}: {
  live: LiveController;
  panel: Panel;
  session: SessionController;
  notebooks: CachedNotebook[];
  noteId?: string | undefined;
  notebookId?: string | undefined;
  onClose?: () => void;
  onNotebookCreated?: (id: string) => void;
}) {
  const close = onClose ?? (() => {});
  return (
    <ConvexProvider client={live.client}>
      {panel === "agents" && <AgentsPanel notebooks={notebooks} />}
      {panel === "account" && <AccountPanel session={session} />}
      {panel === "share" && noteId && (
        <ShareNote noteId={noteId as Id<"notes">} onClose={close} />
      )}
      {panel === "notebook" && (
        <NotebookPanel
          notebookId={(notebookId ?? null) as Id<"notebooks"> | null}
          onClose={close}
          onCreated={onNotebookCreated ?? (() => {})}
        />
      )}
    </ConvexProvider>
  );
}
