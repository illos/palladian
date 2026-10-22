import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { updateApp, type UpdateOutcome } from "./update";

/**
 * The parts of Settings that work without the server: the tab list, the
 * connection and sign-out controls, and About. Tabs that change account data
 * live in the lazy panels module.
 */

export type SettingsTab =
  "account" | "security" | "agents" | "appearance" | "about";

type IconName = Parameters<typeof Icon>[0]["name"];

export const settingsTabs: {
  id: SettingsTab;
  label: string;
  icon: IconName;
}[] = [
  { id: "account", label: "Account", icon: "user" },
  { id: "security", label: "Security & devices", icon: "lock" },
  { id: "agents", label: "Connected agents", icon: "agent" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "about", label: "About", icon: "info" },
];

/** Rows of the phone Settings list, in iOS-style groups. */
const groups: SettingsTab[][] = [
  ["account", "security"],
  ["agents"],
  ["appearance"],
  ["about"],
];

export function settingsLabel(tab: SettingsTab) {
  return settingsTabs.find((entry) => entry.id === tab)!.label;
}

/** `/settings` or `/settings/<tab>`; null for any other path. */
export function settingsRoute(
  pathname: string,
): { tab: SettingsTab | null } | null {
  const match = /^\/settings(?:\/([a-z]+))?\/?$/.exec(pathname);
  if (!match) return null;
  const tab = settingsTabs.find((entry) => entry.id === match[1]);
  return { tab: tab?.id ?? null };
}

export function SettingsList({
  onOpen,
}: {
  onOpen: (tab: SettingsTab) => void;
}) {
  return (
    <nav className="settings-list" aria-label="Settings sections">
      {groups.map((group) => (
        <ul key={group[0]} className="settings-group">
          {group.map((id) => {
            const tab = settingsTabs.find((entry) => entry.id === id)!;
            return (
              <li key={id}>
                <button
                  type="button"
                  className="settings-row"
                  onClick={() => onOpen(id)}
                >
                  <Icon name={tab.icon} size={19} />
                  <span>{tab.label}</span>
                  <Icon name="chevron" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}

/** Connection status, Retry and Sign out: available even while offline. */
export function SessionControls({
  status,
  detail,
  canSignOut,
  onRetry,
  onSignOut,
}: {
  status: string;
  detail: string | null;
  canSignOut: boolean;
  onRetry: () => void;
  onSignOut: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <>
      <section className="settings-section">
        <h3>Connection</h3>
        <p role="status" data-testid="settings-session-status">
          {status}
        </p>
        {detail && <p className="muted">{detail}</p>}
        <button type="button" className="secondary" onClick={onRetry}>
          Retry connection
        </button>
      </section>
      <section className="settings-section">
        <h3>Sign out</h3>
        <p className="muted">
          Notes saved to your account stay there; this device forgets its
          copies. If any drafts have not reached the server, you choose what to
          do with them first.
        </p>
        {confirming ? (
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailure(null);
                onSignOut()
                  .catch(() =>
                    setFailure(
                      "Sign out could not finish. Your notes remain protected from switching accounts.",
                    ),
                  )
                  .finally(() => {
                    setBusy(false);
                    setConfirming(false);
                  });
              }}
            >
              Sign out of this device
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={!canSignOut}
            onClick={() => setConfirming(true)}
          >
            Sign out…
          </button>
        )}
        {failure && (
          <p role="alert" className="error">
            {failure}
          </p>
        )}
      </section>
    </>
  );
}

const outcomes: Record<UpdateOutcome, string> = {
  updating: "Updating…",
  latest: "You're on the latest version.",
  offline: "Connect to the internet to check for updates.",
  unsupported: "Updates install automatically in this browser.",
  unsaved:
    "Your latest typing is not stored on this device yet, so Palladian has not updated. Try again in a moment; if this keeps happening, storage may be full, so copy your text somewhere safe first.",
  installed:
    "The update is installed. It starts the next time Palladian opens, so your open note is not interrupted.",
  failed: "The update could not be installed. Try again later.",
};

export function About({
  ready,
}: {
  ready: (stage: "activate" | "reload") => Promise<boolean>;
}) {
  const [state, setState] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => setWaiting(!!registration?.waiting))
      .catch(() => undefined);
  }, []);
  const built = __NOTES_VERSION__.date
    ? new Date(__NOTES_VERSION__.date).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
  return (
    <div className="about-panel">
      <section className="settings-section">
        <h3>Palladian</h3>
        <dl className="about-facts">
          <dt>Version</dt>
          <dd>{__NOTES_VERSION__.commit}</dd>
          {built && (
            <>
              <dt>Built</dt>
              <dd>{built}</dd>
            </>
          )}
        </dl>
        <p className="muted">
          {waiting
            ? "A new version is ready. Update now to start using it."
            : "Palladian checks for a new version when you ask. It reloads only once everything you have typed is stored on this device."}
        </p>
        <button
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setState("Checking…");
            void updateApp({ ready })
              .then((outcome) => {
                setState(outcomes[outcome]);
                if (outcome !== "updating") setChecking(false);
                if (outcome === "installed") setWaiting(false);
              })
              .catch(() => {
                setState(outcomes.offline);
                setChecking(false);
              });
          }}
        >
          Update now
        </button>
        {state && <p role="status">{state}</p>}
      </section>
    </div>
  );
}
