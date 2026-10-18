import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LiveBox } from "./liveBox";
import type { AuthTransport } from "./auth-service";
import { createNotesStore } from "./cache";
import {
  browserAccountHints,
  type SessionCheck,
  type SessionService,
} from "./session";
import { wireSession } from "./session-wiring";

const store = createNotesStore();
const liveBox = new LiveBox();
const page =
  location.pathname === "/connect"
    ? "connect"
    : location.pathname === "/invite"
      ? "invite"
      : location.pathname === "/reset"
        ? "reset"
        : "notes";
const hints = browserAccountHints(localStorage);
const query = new URLSearchParams(location.search);
const fixture = __NOTES_DEV__ && query.has("fixture");
let mode = query.get("session") ?? "stall";
let transport: AuthTransport = {
  check: async () => ({ kind: "transient", message: "Service not configured" }),
};
const fixtureAccount = "fixture-account";
if (fixture && query.get("fixture") === "seed") hints.remember(fixtureAccount);
const fixtureService: SessionService = {
  async check(signal) {
    if (mode === "stall")
      return new Promise<SessionCheck>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    if (mode === "ready") return { kind: "ready", accountId: fixtureAccount };
    if (mode === "expired") return { kind: "expired" };
    if (mode === "revoked")
      return { kind: "revoked", accountId: fixtureAccount };
    return { kind: "transient", message: "Synthetic unavailable service" };
  },
};
const { session, device } = wireSession({
  store,
  hints,
  transport: () => (fixture ? fixtureService : transport),
  async settleAccount(session, accountId) {
    if (!(await store.hasDrafts(accountId))) return true;
    const { settleDrafts } = await import("./logout");
    return settleDrafts(store, session, accountId, undefined, "switch");
  },
  async prepareLogout(session) {
    const accountId = session.getSnapshot().accountId;
    if (!accountId || !(await store.hasDrafts(accountId))) return true;
    const { settleDrafts } = await import("./logout");
    const live = liveBox.get();
    const flush =
      live && live.getState().ready
        ? async () => {
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
              await live.syncDrafts();
              if (!(await store.hasDrafts(accountId))) return true;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return false;
          }
        : undefined;
    return settleDrafts(store, session, accountId, flush);
  },
});
window.addEventListener("storage", (event) => {
  if (event.key !== "palladian.notes.account-hint.v1") return;
  const hint = hints.read();
  const current = session.getSnapshot().accountId;
  if (current && (hint.signedOut || hint.pendingCleanup === current))
    session.adoptInvalidation(current);
});
const element = document.getElementById("root");
if (!element) throw new Error("Notes root missing");
// No await, token provider, or network initialization stands before the notes UI.
if (page === "notes")
  createRoot(element).render(
    <App session={session} store={store} liveBox={liveBox} />,
  );
if (fixture) {
  Object.assign(window, {
    __notesHarness: {
      store,
      session,
      setSession(next: string) {
        mode = next;
        session.retry({ afterSignIn: true });
      },
    },
  });
  if (query.get("fixture") === "seed")
    void import("./fixtures")
      .then(({ seedFixture }) => seedFixture(store, fixtureAccount))
      .catch(() => {
        console.error("Disposable fixture setup failed.");
      });
}

const siteURL: unknown = __NOTES_AUTH_SITE_URL__;
const convexURL: unknown = __NOTES_CONVEX_URL__;
if (!fixture && typeof siteURL === "string" && siteURL) {
  void Promise.all([import("./auth-service"), import("./SignIn")])
    .then(async ([{ createAuthService }, { SignIn }]) => {
      const connection = createAuthService(
        siteURL,
        typeof convexURL === "string" && convexURL ? convexURL : undefined,
        device,
      );
      transport = connection.service;
      if (typeof convexURL === "string" && convexURL) {
        const { createLive } = await import("./live");
        liveBox.set(createLive(convexURL, connection.auth, store, session));
      }
      if (page !== "notes") {
        const { ConnectPage, InvitePage, ResetPage } = await import("./pages");
        const Page =
          page === "connect"
            ? ConnectPage
            : page === "invite"
              ? InvitePage
              : ResetPage;
        createRoot(element).render(
          <Page session={session} connection={connection} liveBox={liveBox} />,
        );
      } else {
        const panel = document.createElement("section");
        panel.className = "sign-in-layer";
        document.body.append(panel);
        createRoot(panel).render(
          <SignIn connection={connection} session={session} />,
        );
      }
      if (
        session.getSnapshot().status !== "signed-out" &&
        session.getSnapshot().status !== "revoked"
      )
        session.retry();
    })
    .catch(() =>
      console.error("Unable to initialize the authentication interface."),
    );
}

if (!__NOTES_DEV__ && "serviceWorker" in navigator) {
  void navigator.serviceWorker
    .register("/sw.js")
    .catch(() =>
      console.error("Offline shell unavailable; current notes remain usable."),
    );
}
