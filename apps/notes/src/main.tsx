import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createNotesStore, type ActivationFence } from "./cache";
import {
  browserAccountHints,
  SessionController,
  type SessionCheck,
  type SessionService,
} from "./session";

const store = createNotesStore();
const hints = browserAccountHints(localStorage);
const query = new URLSearchParams(location.search);
const fixture = __NOTES_DEV__ && query.has("fixture");
let mode = query.get("session") ?? "stall";
let transport: SessionService = {
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
  async check(signal) {
    const fence = await store.captureActivationFence();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const selected = fixture ? fixtureService : transport;
    const result = await selected.check(signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    activation = fence;
    return result;
  },
  async signOut(signal) {
    await transport?.signOut?.(signal);
  },
};
const session = new SessionController({
  service,
  hints,
  async clearAccount(accountId) {
    activated = null;
    await store.clearAccount(accountId);
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
    // Export/wait-for-save UI is a later integration; never silently discard.
    return confirm(
      "Unsaved local drafts exist. Discard them and sign out? Cancel keeps your drafts.",
    );
  },
});
store.subscribe((event) => {
  if (event.invalidated && event.accountId)
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
createRoot(element).render(<App session={session} store={store} />);
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
if (!fixture && typeof siteURL === "string" && siteURL) {
  void Promise.all([import("./auth-service"), import("./SignIn")])
    .then(([{ createAuthService }, { SignIn }]) => {
      const connection = createAuthService(siteURL);
      transport = connection.service;
      const panel = document.createElement("section");
      document.body.append(panel);
      createRoot(panel).render(
        <SignIn connection={connection} session={session} />,
      );
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
  void navigator.serviceWorker.register("/sw.js").catch(() => console.error("Offline shell unavailable; current notes remain usable."));
}
