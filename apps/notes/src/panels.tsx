import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConvexProvider,
  useAction as useConvexAction,
  useMutation,
  useQuery,
} from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import type { CachedNotebook } from "./cache";
import type { AuthClient } from "./auth-service";
import type { LiveController } from "./live";
import { transportError } from "./live";
import { deviceName, passkeyOffer, passkeysSupported } from "./passkeys";
import { PasswordInput } from "./SignIn";

type Panel = "agents" | "account" | "security" | "share" | "notebook" | "move";
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

/** Invitations already emailed from this page, so a re-render never resends. */
const emailedInvitations = new Map<string, Promise<boolean>>();

function InviteLink({ token, email }: { token: string; email: string }) {
  const link = `${location.origin}/invite#${token}`;
  const sendEmail = useConvexAction(api.invitations.sendEmail);
  const [copied, setCopied] = useState(false);
  const [emailed, setEmailed] = useState<boolean | null>(null);
  useEffect(() => {
    let sending = emailedInvitations.get(token);
    if (!sending) {
      sending = sendEmail({ token }).catch(() => false);
      emailedInvitations.set(token, sending);
    }
    let active = true;
    void sending.then((sent) => {
      if (active) setEmailed(sent);
    });
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <div className="invite-link">
      <p role="status">
        {emailed === null
          ? `Emailing an invitation to ${email}…`
          : emailed
            ? `Invitation emailed to ${email}. You can also send them this single-use link; it expires in 14 days.`
            : `The invitation email could not be sent. Send ${email} this single-use link instead; it expires in 14 days.`}
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
  const [invited, setInvited] = useState<{
    token: string;
    email: string;
  } | null>(null);
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
          const address = email.trim();
          void onInvite(email, role).then((result) => {
            setInvited(result ? { token: result, email: address } : null);
            setEmail("");
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
      {invited && <InviteLink token={invited.token} email={invited.email} />}
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
      <PublicLink noteId={noteId} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}

function PublicLink({ noteId }: { noteId: Id<"notes"> }) {
  const status = useQuery(api.publishing.status, { noteId });
  const publish = useMutation(api.publishing.publish);
  const unpublish = useMutation(api.publishing.unpublish);
  const replace = useMutation(api.publishing.replace);
  const { error, busy, run } = useAction();
  const [copied, setCopied] = useState(false);
  if (!status) return null;
  const link = status.token ? `${location.origin}/p/${status.token}` : null;
  return (
    <section className="public-link">
      <h3>Public link</h3>
      {link ? (
        <>
          <p className="muted">
            Anyone with this link can read the latest saved version. It is
            hidden while the note is in Trash.
          </p>
          <div className="invite-link">
            <input
              readOnly
              value={link}
              aria-label="Public link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="button-row">
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
              {status.canPublish && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(() => unpublish({ noteId }))}
                >
                  Stop sharing publicly
                </button>
              )}
              {status.canReplace && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Replace the link? The current link will stop working permanently.",
                      )
                    )
                      void run(() => replace({ noteId }));
                  }}
                >
                  Replace link
                </button>
              )}
            </div>
          </div>
        </>
      ) : status.canPublish ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => publish({ noteId }))}
        >
          Create public link
        </button>
      ) : (
        <p className="muted">Not public.</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function MoveNote({
  noteId,
  onClose,
}: {
  noteId: Id<"notes">;
  onClose: () => void;
}) {
  const note = useQuery(api.notes.get, { noteId });
  const notebooks = useQuery(api.library.notebooks, {});
  const move = useMutation(api.lifecycle.move);
  const [target, setTarget] = useState("");
  const preview = useQuery(
    api.lifecycle.movePreview,
    target ? { noteId, notebookId: target as Id<"notebooks"> } : "skip",
  );
  const { error, busy, run } = useAction();
  const choices = (notebooks ?? []).filter(
    (n) =>
      note &&
      n.ownerId === note.ownerId &&
      n.id !== note.summary.notebookId &&
      n.role !== "read",
  );
  return (
    <Modal label="Move note" onClose={onClose}>
      <form
        className="stacked-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!target) return;
          void run(() =>
            move({ noteId, notebookId: target as Id<"notebooks"> }),
          ).then((ok) => ok && onClose());
        }}
      >
        <label>
          Notebook
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a notebook…</option>
            {choices.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        {preview && preview.length > 0 && (
          <p className="error">
            {preview.map((p) => p.name).join(", ")} will lose access to this
            note.
          </p>
        )}
        <button disabled={busy || !target}>Move</button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
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
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
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
              {renaming?.id === agent.agentId ? (
                <form
                  className="inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() =>
                      updateAgent({
                        agentId: agent.agentId,
                        name: renaming.name,
                      }),
                    ).then((done) => done && setRenaming(null));
                  }}
                >
                  <input
                    aria-label="Agent name"
                    value={renaming.name}
                    maxLength={60}
                    autoFocus
                    onChange={(event) =>
                      setRenaming({
                        id: agent.agentId,
                        name: event.target.value,
                      })
                    }
                  />
                  <button disabled={busy}>Save</button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <h3>{agent.name}</h3>
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`Rename ${agent.name}`}
                    onClick={() =>
                      setRenaming({ id: agent.agentId, name: agent.name })
                    }
                  >
                    Rename
                  </button>
                </>
              )}
              <span className="muted">
                {agent.disabled
                  ? "Paused"
                  : active.length
                    ? `${active.length} active connection${active.length > 1 ? "s" : ""}`
                    : "Not connected"}
              </span>
            </header>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={agent.disabled}
                disabled={busy}
                onChange={(event) =>
                  void run(() =>
                    updateAgent({
                      agentId: agent.agentId,
                      disabled: event.target.checked,
                    }),
                  )
                }
              />
              Pause this agent: it cannot read or change anything until you turn
              this off
            </label>
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
                    disconnecting === connection.id ? (
                      <span className="button-row">
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              revoke({ connectionId: connection.id }),
                            ).then(() => setDisconnecting(null))
                          }
                        >
                          Disconnect
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setDisconnecting(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => setDisconnecting(connection.id)}
                      >
                        Disconnect…
                      </button>
                    )
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

interface PasskeyRow {
  id: string;
  name?: string | null | undefined;
  createdAt: Date | string | number;
  backedUp: boolean;
}

/** Passkeys and password: everything that signs this person in. */
function SecuritySection({ auth, email }: { auth: AuthClient; email: string }) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await auth.passkey.listUserPasskeys();
    if (result.data) setPasskeys(result.data);
    else setError("Passkeys could not be loaded.");
  }, [auth]);
  useEffect(() => {
    void load().catch(() => setError("Passkeys could not be loaded."));
  }, [load]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const add = () =>
    act(async () => {
      const result = await auth.passkey.addPasskey({ name: deviceName() });
      if (!result.error) {
        passkeyOffer.settle();
        setMessage("Passkey added.");
        await load();
      } else if (result.error.status === 403) setConfirming(true);
      else if (!/cancel/i.test(result.error.message ?? ""))
        setError(
          result.error.message?.includes("previously registered")
            ? "This device already has a passkey for your account."
            : "The passkey could not be added.",
        );
    });
  return (
    <section className="member-list security-section">
      <h3>Sign-in &amp; security</h3>
      <h4>Passkeys</h4>
      <p className="muted">
        Sign in with Face ID, Touch ID or your device passcode instead of your
        password.
      </p>
      {passkeys?.length === 0 && <p className="muted">No passkeys yet.</p>}
      <ul>
        {passkeys?.map((passkey) => (
          <li key={passkey.id}>
            <span>
              {passkey.name || "Passkey"} · added{" "}
              {new Date(passkey.createdAt).toLocaleDateString()}
              {passkey.backedUp ? " · synced" : ""}
            </span>
            {removing === passkey.id ? (
              <span className="button-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await auth.passkey.deletePasskey({
                        id: passkey.id,
                      });
                      if (result.error)
                        setError("The passkey could not be removed.");
                      setRemoving(null);
                      await load();
                    })
                  }
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setRemoving(null)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setRemoving(passkey.id)}
              >
                Remove…
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirming ? (
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const result = await auth.signIn.email({ email, password });
              if (result.error) {
                setError("That password is not right.");
                return;
              }
              setPassword("");
              setConfirming(false);
              await add();
            });
          }}
        >
          <PasswordInput
            label="Confirm your password to add a passkey"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <div className="button-row">
            <button disabled={busy}>Continue</button>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        passkeysSupported() && (
          <button type="button" disabled={busy} onClick={() => void add()}>
            Add a passkey on this device
          </button>
        )
      )}
      <h4>Password</h4>
      <p className="muted">
        To change your password, we email you a link. Changing it signs out your
        other devices.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const result = await auth.requestPasswordReset({ email });
            if (result.error)
              setError(
                result.error.status === 429
                  ? "Too many requests. Wait a few minutes and try again."
                  : "The email could not be requested.",
              );
            else
              setMessage(
                `We emailed a link to ${email}. It works once, for one hour.`,
              );
          })
        }
      >
        Email me a password link
      </button>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function shortDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Devices signed in to this account, listed by ID; tokens stay on the server. */
function DevicesSection() {
  const devices = useQuery(api.devices.list, {});
  const revoke = useMutation(api.devices.revoke);
  const revokeOthers = useMutation(api.devices.revokeOthers);
  const { error, busy, run } = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const others = devices?.filter((device) => !device.current) ?? [];
  return (
    <section className="member-list security-section devices-section">
      <h3>Signed-in devices</h3>
      <p className="muted">
        Signing a device out ends its session at once. It keeps the notes it
        already downloaded and asks to sign in again before it can sync.
      </p>
      {devices === undefined && <p>Loading…</p>}
      <ul>
        {devices?.map((device) => (
          <li key={device.id}>
            <span>
              <strong>
                {device.label}
                {device.current ? " · This device" : ""}
              </strong>
              <small className="muted">
                Signed in {shortDate(device.signedInAt)} · active{" "}
                {shortDate(device.lastActiveAt)}
              </small>
            </span>
            {!device.current &&
              (confirming === device.id ? (
                <span className="button-row">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(() => revoke({ id: device.id })).then(() =>
                        setConfirming(null),
                      )
                    }
                  >
                    Sign out
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`Sign out ${device.label}`}
                  onClick={() => setConfirming(device.id)}
                >
                  Sign out…
                </button>
              ))}
          </li>
        ))}
      </ul>
      {others.length > 1 &&
        (confirming === "others" ? (
          <span className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(() => revokeOthers({})).then(() => setConfirming(null))
              }
            >
              Sign out {others.length} devices
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirming(null)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setConfirming("others")}
          >
            Sign out all other devices…
          </button>
        ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function SecurityPanel({ auth }: { auth: AuthClient }) {
  const me = useQuery(api.account.me, {});
  if (me === undefined) return <p>Loading…</p>;
  return (
    <div className="account-panel">
      {me?.email && <SecuritySection auth={auth} email={me.email} />}
      <DevicesSection />
    </div>
  );
}

function AccountPanel({ notebooks }: { notebooks: CachedNotebook[] }) {
  const me = useQuery(api.account.me, {});
  const rename = useMutation(api.account.rename);
  const setDefault = useMutation(api.notebooks.setDefault);
  const owned = notebooks.filter((notebook) => notebook.role === "owner");
  const pending = useQuery(api.invitations.pending, {});
  const revokeInvite = useMutation(api.invitations.revoke);
  const setRetention = useMutation(api.lifecycle.setTrashRetention);
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
      {me && owned.length > 0 && (
        <label className="stacked-form">
          New notes from All Notes go to
          <select
            value={me.defaultNotebookId ?? ""}
            disabled={busy}
            onChange={(event) =>
              void run(() =>
                setDefault({
                  notebookId: event.target.value as Id<"notebooks">,
                }),
              )
            }
          >
            {me.defaultNotebookId === null && (
              <option value="" disabled>
                Choose a notebook
              </option>
            )}
            {owned.map((notebook) => (
              <option key={notebook.id} value={notebook.id}>
                {notebook.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {me && (
        <label className="stacked-form">
          Keep notes in Trash for
          <select
            value={me.trashRetentionDays}
            disabled={busy}
            onChange={(event) =>
              void run(() => setRetention({ days: Number(event.target.value) }))
            }
          >
            <option value={1}>1 day</option>
            <option value={7}>1 week</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={0}>Forever (empty manually)</option>
          </select>
        </label>
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
  notebooks,
  noteId,
  notebookId,
  onClose,
  onNotebookCreated,
}: {
  live: LiveController;
  panel: Panel;
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
      {panel === "account" && <AccountPanel notebooks={notebooks} />}
      {panel === "security" && <SecurityPanel auth={live.auth} />}
      {panel === "share" && noteId && (
        <ShareNote noteId={noteId as Id<"notes">} onClose={close} />
      )}
      {panel === "move" && noteId && (
        <MoveNote noteId={noteId as Id<"notes">} onClose={close} />
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
