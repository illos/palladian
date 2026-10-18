import type { AuthTransport, DeviceStore } from "./auth-service";
import type { ActivationFence, NotesStore } from "./cache";
import {
  SessionController,
  type AccountHintStore,
  type SessionOptions,
} from "./session";

/**
 * The session controller wired to the notes cache: activation fences, the
 * device records' clean-up (D98), and invalidations from the cache.
 */
export function wireSession(options: {
  store: NotesStore;
  hints: AccountHintStore;
  /** The current session transport (the fixture harness swaps it). */
  transport: () => AuthTransport;
  settleAccount(
    session: SessionController,
    accountId: string,
  ): Promise<boolean>;
  prepareLogout?(session: SessionController): Promise<boolean>;
  schedule?: SessionOptions["schedule"];
}) {
  const { store, hints } = options;
  let activation: ActivationFence | null = null;
  let activated: string | null = null;
  // Accounts this tab is clearing for a device check: its own clean-up is
  // not someone signing the session out.
  const reconciling = new Set<string>();

  const device: DeviceStore = {
    secret: () => store.deviceSecret(),
    lifecycle: (accountId) => store.lifecycleOf(accountId),
    async clear(accountId, lifecycle) {
      reconciling.add(accountId);
      try {
        // False: a tab began a newer lifecycle meanwhile; check again.
        if (
          !(await store.clearAccount(accountId, crypto.randomUUID(), lifecycle))
        )
          throw new Error("Clear superseded");
      } finally {
        reconciling.delete(accountId);
      }
    },
  };

  const session: SessionController = new SessionController({
    service: {
      async check(signal, accountId) {
        // At most one extra round: after the browser has cleared older
        // copies of the account and recorded itself current (D98), check
        // again under a fresh fence, since that clear ended the first.
        for (let round = 0; round < 2; round++) {
          const fence = await store.captureActivationFence();
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const result = await options.transport().check(signal, accountId);
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (result.kind === "reconciled") continue;
          activation = fence;
          return result;
        }
        return { kind: "transient", message: "Device check did not settle" };
      },
      async signOut(signal) {
        await options.transport().signOut?.(signal);
      },
    },
    hints,
    async clearAccount(accountId, operation) {
      activated = null;
      await store.clearAccount(accountId, operation);
    },
    finishCleanup: (accountId) => store.finishClear(accountId),
    settleAccount: (accountId) => options.settleAccount(session, accountId),
    async onAccountReady(accountId, isCurrent) {
      if (activated === accountId) return;
      if (!activation || !isCurrent())
        throw new Error("Session attempt changed");
      await store.allowAccount(accountId, activation, isCurrent);
      if (!isCurrent()) throw new Error("Session attempt changed");
      activated = accountId;
    },
    ...(options.prepareLogout
      ? { prepareLogout: () => options.prepareLogout!(session) }
      : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });

  store.subscribe((event) => {
    if (!event.invalidated || !event.accountId) return;
    // The cache blocked this account; signing in again must activate it anew.
    if (activated === event.accountId) activated = null;
    if (reconciling.has(event.accountId)) return;
    session.adoptInvalidation(event.accountId);
  });

  return { session, device };
}
