import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LiveBox } from "./liveBox";
import type { AuthTransport } from "./auth-service";
import { createNotesStore, type ActivationFence } from "./cache";
import {
  browserAccountHints,
  SessionController,
  type SessionCheck,
  type SessionService,
} from "./session";

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
let activation: ActivationFence | null = null;
let activated: string | null = null;
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
const service: SessionService = {
  async check(signal, accountId) {
    // At most one extra round: after the browser has cleared older copies of
    // the account and recorded itself current (D98), check again under a
    // fresh fence, since that clear ended the fence captured first.
    for (let round = 0; round < 2; round++) {
      const fence = await store.captureActivationFence();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const selected = fixture ? fixtureService : transport;
      const result = await selected.check(signal, accountId);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (result.kind === "reconciled") continue;
      activation = fence;
      return result;
    }
    return { kind: "transient", message: "Device check did not settle" };
  },
  async signOut(signal) {
    await transport?.signOut?.(signal);
  },
};
const session = new SessionController({
  service,
  hints,
  async clearAccount(accountId, operation) {
    activated = null;
    await store.clearAccount(accountId, operation);
  },
  finishCleanup: (accountId) => store.finishClear(accountId),
  async settleAccount(accountId) {
    if (!(await store.hasDrafts(accountId))) return true;
    const { settleDrafts } = await import("./logout");
    return settleDrafts(store, session, accountId, undefined, "switch");
  },
  async onAccountReady(accountId, isCurrent) {
    if (activated === accountId) return;
    if (!activation || !isCurrent()) throw new Error("Session attempt changed");
    await store.allowAccount(accountId, activation, isCurrent);
    if (!isCurrent()) throw new Error("Session attempt changed");
    activated = accountId;
  },
  async prepareLogout() {
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
store.subscribe((event) => {
  if (!event.invalidated || !event.accountId) return;
  // The cache blocked this account; signing in again must activate it anew.
  if (activated === event.accountId) activated = null;
  session.adoptInvalidation(event.accountId);
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
        {
          secret: () => store.deviceSecret(),
          hasCopies: (accountId) => store.hasCopies(accountId),
          async clear(accountId) {
            // False: the account was signed in again meanwhile; check again.
            if (!(await store.clearAccount(accountId, crypto.randomUUID())))
              throw new Error("Clear superseded");
          },
        },
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
