import { Component, Suspense, lazy, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ThemePreference } from "../../../packages/contracts/src/index";
import { definitions } from "./registry";
import "../../../packages/ui/src/tokens.css";
import "./shell.css";
const previews = definitions.map((def) => ({
  ...def,
  View: lazy(async () => ({ default: (await def.loadUI()).Preview })),
}));
class AppBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Never log arbitrary app content. */
  }
  render() {
    return this.state.failed ? (
      <section role="alert">
        <h2>This app couldn’t open.</h2>
        <p>
          Your home is still available. Return home and try again, or reload to
          fetch the latest build.
        </p>
        <button onClick={() => location.reload()}>Reload</button>
      </section>
    ) : (
      this.props.children
    );
  }
}
function Shell() {
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const value = document.documentElement.dataset.theme;
    return value === "dark" || value === "light" ? value : "system";
  });
  const entry = previews.find((def) => def.id === selected);
  function changeTheme(value: ThemePreference) {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("palladian.theme", value);
    } catch {
      /* Usable without storage. */
    }
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <aside className="sidebar">
          <a className="wordmark" href="/" aria-label="Palladian home">
            <span aria-hidden="true">▥</span> Palladian
          </a>
          <nav aria-label="Main">
            <button
              className={!entry ? "active" : ""}
              onClick={() => setSelected(null)}
            >
              ⌂ <span>Home</span>
            </button>
            <p className="nav-label">Explore apps</p>
            {previews.map((def) => (
              <button
                key={def.id}
                aria-pressed={selected === def.id}
                onClick={() => setSelected(def.id)}
              >
                {def.icon === "note" ? "▤" : "◈"} <span>{def.name}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="status-dot" /> Foundation preview
            <p>Authentication is not connected.</p>
          </div>
        </aside>
        <div className="workspace">
          <header>
            <span className="breadcrumb">
              Your space <span aria-hidden="true">/</span>{" "}
              {entry?.name ?? "Home"}
            </span>
            <label className="theme-label">
              Theme{" "}
              <select
                value={theme}
                onChange={(event) =>
                  changeTheme(event.target.value as ThemePreference)
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </header>
          <main id="main" tabIndex={-1}>
            {entry ? (
              <>
                <button className="back" onClick={() => setSelected(null)}>
                  ← All apps
                </button>
                <div className="app-preview">
                  <AppBoundary key={entry.id}>
                    <Suspense
                      fallback={<p role="status">Opening {entry.name}…</p>}
                    >
                      <entry.View />
                    </Suspense>
                  </AppBoundary>
                </div>
              </>
            ) : (
              <>
                <div className="intro">
                  <p className="eyebrow">
                    A little more room for everyday life
                  </p>
                  <h1>Everything in its place.</h1>
                  <p>
                    Your ideas, your collections, your small useful tools.
                    <br />
                    One calm place to begin.
                  </p>
                </div>
                <section aria-labelledby="apps-heading">
                  <div className="section-heading">
                    <h2 id="apps-heading">Your apps</h2>
                    <span>Foundation · P0</span>
                  </div>
                  <div className="app-grid">
                    {previews.map((def) => (
                      <button
                        className={`app-card ${def.id}`}
                        key={def.id}
                        onClick={() => setSelected(def.id)}
                      >
                        <span className="app-icon" aria-hidden="true">
                          {def.icon === "note" ? "▤" : "◈"}
                        </span>
                        <span className="card-title">
                          {def.name}
                          <span aria-hidden="true">↗</span>
                        </span>
                        <span className="card-description">
                          {def.description}
                        </span>
                        <span className="card-footer">
                          Explore empty preview{" "}
                          <span aria-hidden="true">→</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
                <section
                  className="foundation"
                  aria-labelledby="foundation-title"
                >
                  <span className="foundation-icon" aria-hidden="true">
                    ◇
                  </span>
                  <div>
                    <h2 id="foundation-title">A foundation to build on.</h2>
                    <p>
                      These are app previews. Sign-in and private workspaces are
                      not available yet. Nothing you see here is saved personal
                      data.
                    </p>
                  </div>
                </section>
              </>
            )}
          </main>
          <footer>
            Palladian <span>A home for the things you make.</span>
          </footer>
        </div>
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing shell root");
createRoot(root).render(<Shell />);
