import { Component, type ReactNode } from "react";

/**
 * Keeps a failing server-backed section from blanking the app. When the server
 * no longer accepts this device's session (another device signed it out, or a
 * password reset did), `onSignedOut` rechecks the session, which asks for a
 * sign-in while the cached notes stay readable (D83).
 */
export class PanelBoundary extends Component<
  { children: ReactNode; onSignedOut: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    const data = (error as { data?: { code?: unknown } } | null)?.data;
    if (data?.code === "unauthenticated") this.props.onSignedOut();
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel-failure" role="alert">
        <p>This section could not load.</p>
        <button
          type="button"
          className="secondary"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    );
  }
}
