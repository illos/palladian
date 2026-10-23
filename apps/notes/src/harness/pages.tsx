import { createRoot } from "react-dom/client";
import type { createAuthService } from "../auth-service";
import { LiveBox } from "../liveBox";
import { ConnectPage, InvitePage, ResetPage } from "../pages";
import {
  browserAccountHints,
  SessionController,
  type SessionCheck,
} from "../session";
import "../theme.css";
import "../styles.css";

/**
 * Test-only page (harness/pages.html, served by the dev server, not built):
 * the agent connect, invitation or reset page (`?page=connect|invite|reset`)
 * as main.tsx mounts it, with a real SessionController and account hint and
 * a session service the browser tests script. The real pages render only
 * with an authentication service configured, which the browser suite's dev
 * server has not; these pages can sign out, see a revoked session or switch
 * accounts, so their attachment cache lifecycle is tested here (review
 * round 1 of B3, F1).
 */
interface PagesHarness {
  /** The session service's next answer; `check()` asks again at once. */
  answer(next: SessionCheck): void;
  status(): string;
}
declare global {
  interface Window {
    __pages: PagesHarness;
  }
}

let next: SessionCheck = { kind: "ready", accountId: "ada" };
const session = new SessionController({
  service: {
    check: async () => next,
    signOut: async () => undefined,
  },
  hints: browserAccountHints(localStorage),
  clearAccount: async () => undefined,
  finishCleanup: async () => undefined,
  settleAccount: async () => true,
});
window.__pages = {
  answer(value) {
    next = value;
    session.retry({ afterSignIn: true });
  },
  status: () => session.getSnapshot().status,
};

/** An authentication client that never answers: these pages only show it. */
function inert(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) => (property === "then" ? undefined : inert()),
    apply: () => new Promise(() => undefined),
  });
}
const connection = {
  auth: inert(),
  service: { check: async () => next },
} as unknown as ReturnType<typeof createAuthService>;
const liveBox = new LiveBox();

const which = new URLSearchParams(location.search).get("page");
const Page =
  which === "invite" ? InvitePage : which === "reset" ? ResetPage : ConnectPage;
createRoot(document.getElementById("root")!).render(
  <Page session={session} connection={connection} liveBox={liveBox} />,
);
