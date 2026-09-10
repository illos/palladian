import { Component, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type {
  DefinitionId,
  ThemePreference,
} from "../../../../packages/contracts/src/index";
import { instanceHref } from "../../../../packages/contracts/src/routes";
import "./workspace.css";
import { appInstance } from "./adapter";

type WorkspaceView = NonNullable<
  typeof api.platform.workspaces.current._returnType
>;
type InstanceView = typeof api.platform.instances.get._returnType;
function failure(error: unknown): string {
  const code =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data
      ? error.data.code
      : null;
  if (code === "CONFLICT")
    return "This changed elsewhere. Your input is retained. Load the latest version before trying again.";
  if (code === "NOT_FOUND")
    return "This item is unavailable. It may have been archived.";
  if (code === "VALIDATION") return "Check your input and try again.";
  return "The change could not be confirmed. Your input is retained; try again.";
}
class InstanceBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        This instance is unavailable. <a href="/">Return to workspace</a>
      </p>
    ) : (
      this.props.children
    );
  }
}
function Preferences({ instance }: { instance: InstanceView }) {
  const scope = { workspaceId: instance.workspaceId, instanceId: instance.id };
  const notes = useQuery(
    api.apps.notes.instances.preferences,
    instance.definitionId === "notes" ? scope : "skip",
  );
  const recipes = useQuery(
    api.apps.recipes.instances.preferences,
    instance.definitionId === "recipes" ? scope : "skip",
  );
  const saveNotes = useMutation(api.apps.notes.instances.setPreferences);
  const saveRecipes = useMutation(api.apps.recipes.instances.setPreferences);
  const preferences = instance.definitionId === "notes" ? notes : recipes;
  if (!preferences) return <p role="status">Loading preferences…</p>;
  return (
    <PreferenceForm
      key={preferences.id}
      preferences={preferences}
      save={instance.definitionId === "notes" ? saveNotes : saveRecipes}
    />
  );
}
type PreferencesView = typeof api.apps.notes.instances.preferences._returnType;
function PreferenceForm({
  preferences,
  save,
}: {
  preferences: PreferencesView;
  save: (
    args: typeof api.apps.notes.instances.setPreferences._args,
  ) => Promise<PreferencesView>;
}) {
  const [density, setDensity] = useState(preferences.density);
  const [revision, setRevision] = useState(preferences.revision);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void save({
          workspaceId: preferences.workspaceId,
          instanceId: preferences.instanceId,
          preferencesId: preferences.id,
          expectedRevision: revision,
          density,
        })
          .then((saved) => {
            if (mounted.current) {
              setRevision(saved.revision);
              setMessage("Preferences saved.");
            }
          })
          .catch((error: unknown) => {
            if (mounted.current) setMessage(failure(error));
          })
          .finally(() => {
            if (mounted.current) setBusy(false);
          });
      }}
    >
      <label>
        Instance density
        <select
          value={density}
          disabled={busy}
          onChange={(event) =>
            setDensity(
              event.target.value === "compact" ? "compact" : "comfortable",
            )
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <button disabled={busy}>Save preferences</button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setDensity(preferences.density);
          setRevision(preferences.revision);
          setMessage("Latest preferences loaded.");
        }}
      >
        Load latest preferences
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
function WorkspaceTheme({ workspace }: { workspace: WorkspaceView }) {
  const save = useMutation(api.platform.workspaces.setTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = workspace.theme;
    try {
      localStorage.setItem("palladian.theme", workspace.theme);
    } catch {
      /* First paint remains usable without storage. */
    }
    window.dispatchEvent(
      new CustomEvent("palladian-theme-reconciled", {
        detail: workspace.theme,
      }),
    );
  }, [workspace.theme]);
  const [theme, setTheme] = useState<ThemePreference>(workspace.theme);
  const [revision, setRevision] = useState(workspace.revision);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void save({
          workspaceId: workspace.id,
          expectedRevision: revision,
          theme,
        })
          .then((saved) => {
            if (mounted.current) {
              setRevision(saved.revision);
              setMessage("Workspace theme saved.");
            }
          })
          .catch((error: unknown) => {
            if (mounted.current) setMessage(failure(error));
          })
          .finally(() => {
            if (mounted.current) setBusy(false);
          });
      }}
    >
      <label>
        Workspace theme
        <select
          aria-label="Workspace theme"
          value={theme}
          disabled={busy}
          onChange={(event) =>
            setTheme(
              event.target.value === "dark"
                ? "dark"
                : event.target.value === "light"
                  ? "light"
                  : "system",
            )
          }
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <button disabled={busy}>Save workspace theme</button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setTheme(workspace.theme);
          setRevision(workspace.revision);
          setMessage("Latest theme loaded.");
        }}
      >
        Load latest theme
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
function InstanceEditor({ instance }: { instance: InstanceView }) {
  const logicalInstance = appInstance(instance);
  const rename = useMutation(api.platform.instances.rename);
  const archive = useMutation(api.platform.instances.archive);
  const [title, setTitle] = useState(instance.title);
  const [revision, setRevision] = useState(instance.revision);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <article
      className="instance-editor"
      data-testid="instance-editor"
      data-instance-id={instance.id}
    >
      <h3>{instance.title}</h3>
      <p>
        {instance.definitionId === "notes" ? "Notes" : "Recipes"} ·{" "}
        {instance.lifecycle}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setMessage("");
          void rename({
            workspaceId: instance.workspaceId,
            instanceId: instance.id,
            title,
            expectedRevision: revision,
          })
            .then((saved) => {
              if (mounted.current) {
                setTitle(saved.title);
                setRevision(saved.revision);
                setMessage("Name saved.");
              }
            })
            .catch((error: unknown) => {
              if (mounted.current) setMessage(failure(error));
            })
            .finally(() => {
              if (mounted.current) setBusy(false);
            });
        }}
      >
        <label>
          Instance name
          <input
            value={title}
            disabled={busy}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button disabled={busy || instance.lifecycle !== "active"}>
          Save name
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setTitle(instance.title);
            setRevision(instance.revision);
            setMessage("Latest version loaded.");
          }}
        >
          Load latest version
        </button>
      </form>
      <p role="status">{message}</p>
      {instance.lifecycle === "active" && <Preferences instance={instance} />}
      {instance.lifecycle === "active" && (
        <>
          <p>
            <a
              href={instanceHref(
                logicalInstance.workspaceId,
                logicalInstance.id,
                "integrated",
              )}
            >
              Open in workspace
            </a>
            {" · "}
            <a
              href={instanceHref(
                logicalInstance.workspaceId,
                logicalInstance.id,
                "standalone",
              )}
            >
              Open standalone
            </a>
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void archive({
                workspaceId: instance.workspaceId,
                instanceId: instance.id,
                expectedRevision: revision,
              })
                .catch((error: unknown) => {
                  if (mounted.current) setMessage(failure(error));
                })
                .finally(() => {
                  if (mounted.current) setBusy(false);
                });
            }}
          >
            Archive instance
          </button>
        </>
      )}
    </article>
  );
}
function Instances({ workspace }: { workspace: WorkspaceView }) {
  const [lifecycle, setLifecycle] = useState<"active" | "archived">("active");
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(api.platform.instances.list, {
    workspaceId: workspace.id,
    lifecycle,
    cursor,
  });
  const create = useMutation(api.platform.instances.create);
  const [definition, setDefinition] = useState<DefinitionId>("notes");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const fingerprint = JSON.stringify([definition, title.trim()]);
          if (intent.current?.fingerprint !== fingerprint)
            intent.current = { fingerprint, key: crypto.randomUUID() };
          setBusy(true);
          setMessage("");
          void create({
            workspaceId: workspace.id,
            definitionId: definition,
            title,
            idempotencyKey: intent.current.key,
          })
            .then(() => {
              if (mounted.current) {
                intent.current = null;
                setTitle("");
                setCursor(null);
                setLifecycle("active");
                setMessage("Instance created.");
              }
            })
            .catch((error: unknown) => {
              if (mounted.current) setMessage(failure(error));
            })
            .finally(() => {
              if (mounted.current) setBusy(false);
            });
        }}
      >
        <label>
          App
          <select
            value={definition}
            disabled={busy}
            onChange={(event) =>
              setDefinition(
                event.target.value === "recipes" ? "recipes" : "notes",
              )
            }
          >
            <option value="notes">Notes</option>
            <option value="recipes">Recipes</option>
          </select>
        </label>
        <label>
          New instance name
          <input
            value={title}
            disabled={busy}
            required
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button disabled={busy}>Create instance</button>
      </form>
      <p role="status">{message}</p>
      <label>
        Show instances
        <select
          value={lifecycle}
          onChange={(event) => {
            setLifecycle(
              event.target.value === "archived" ? "archived" : "active",
            );
            setCursor(null);
          }}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      {!result ? (
        <p role="status">Loading instances…</p>
      ) : (
        <>
          <div className="instance-list">
            {result.items.map((instance) => (
              <InstanceEditor key={instance.id} instance={instance} />
            ))}
          </div>
          {result.items.length === 0 && <p>No {lifecycle} instances.</p>}
          <button disabled={cursor === null} onClick={() => setCursor(null)}>
            First page
          </button>
          <button
            disabled={result.cursor === null}
            onClick={() => setCursor(result.cursor)}
          >
            Next page
          </button>
        </>
      )}
    </>
  );
}
function ResolvedInstance({
  workspaceId,
  instanceId,
  standalone,
}: {
  workspaceId?: Id<"workspaces">;
  instanceId: Id<"appInstances">;
  standalone: boolean;
}) {
  const resolved = useQuery(api.platform.routes.resolveInstance, {
    instanceId,
    ...(workspaceId ? { workspaceId } : {}),
    presentation: standalone ? "standalone" : "integrated",
  });
  if (!resolved) return <p role="status">Opening instance…</p>;
  return (
    <>
      <p>
        {standalone ? "Standalone" : "Workspace"} view ·{" "}
        <a href="/">Return home</a>
      </p>
      <InstanceEditor key={resolved.instance.id} instance={resolved.instance} />
      <p>
        Instance settings are available. Notes and recipe content are the next
        milestone.
      </p>
    </>
  );
}
export default function Workspace() {
  const ensure = useMutation(api.platform.workspaces.ensure);
  const workspace = useQuery(api.platform.workspaces.current, {});
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (workspace !== null) return;
    let active = true;
    void ensure({}).catch(() => {
      if (active)
        setMessage("Workspace setup needs a retry. Reload to reconnect.");
    });
    return () => {
      active = false;
    };
  }, [workspace, ensure]);
  if (!workspace) return <p role="status">{message || "Opening workspace…"}</p>;
  // Route values are untrusted references. The server validates their generated
  // ID format, live ownership, actual parent and lifecycle before returning data.
  const integrated = location.pathname.match(/^\/w\/([^/]+)\/a\/([^/]+)\/?$/);
  const standalone = location.pathname.match(/^\/a\/([^/]+)\/?$/);
  return (
    <section className="workspace" aria-label="Workspace">
      <h2>{workspace.title}</h2>
      <WorkspaceTheme workspace={workspace} />
      <InstanceBoundary>
        {integrated ? (
          <ResolvedInstance
            workspaceId={integrated[1] as Id<"workspaces">}
            instanceId={integrated[2] as Id<"appInstances">}
            standalone={false}
          />
        ) : standalone ? (
          <ResolvedInstance
            instanceId={standalone[1] as Id<"appInstances">}
            standalone
          />
        ) : (
          <Instances workspace={workspace} />
        )}
      </InstanceBoundary>
    </section>
  );
}
