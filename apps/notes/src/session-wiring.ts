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
  // A revocation whose clean-up the device check already did, and under
  // which lifecycle: the controller's own clean-up repeats it under the same
  // one, never adopting a lifecycle another tab has begun since.
  let clearedInCheck: { accountId: string; lifecycle: number } | null = null;
  let checkedRevocation: { accountId: string; lifecycle: number } | null = null;
  // Set by the device store during a check, so read through a function.
  const clearedDuringCheck = () => clearedInCheck;

  const device: DeviceStore = {
    secret: () => store.deviceSecret(),
    lifecycle: (accountId) => store.lifecycleOf(accountId),
    async clear(accountId, lifecycle, purpose) {
      reconciling.add(accountId);
      try {
        const cleared = await store.clearAccount(
          accountId,
          crypto.randomUUID(),
          { lifecycle, reconcile: purpose === "reconcile" },
        );
        // False: a tab began a newer lifecycle meanwhile; check again.
        if (!cleared) throw new Error("Clear superseded");
        if (purpose === "revoke") clearedInCheck = { accountId, lifecycle };
      } finally {
        reconciling.delete(accountId);
      }
    },
  };

  const session: SessionController = new SessionController({
    service: {
      async check(signal, accountId) {
        checkedRevocation = null;
        // At most one extra round: after the browser has cleared older
        // copies of the account and recorded itself current (D98), check
        // again under a fresh fence, since that clear ended the first.
        for (let round = 0; round < 2; round++) {
          clearedInCheck = null;
          const fence = await store.captureActivationFence();
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const result = await options.transport().check(signal, accountId);
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (result.kind === "reconciled") continue;
          const cleared = clearedDuringCheck();
          if (
            result.kind === "revoked" &&
            cleared?.accountId === result.accountId
          )
            checkedRevocation = cleared;
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
      const already =
        checkedRevocation?.accountId === accountId ? checkedRevocation : null;
      checkedRevocation = null;
      // Already cleared under that lifecycle by the device check: a refusal
      // here means a newer one began meanwhile, which this must not touch.
      await store.clearAccount(
        accountId,
        operation,
        already ? { lifecycle: already.lifecycle } : {},
      );
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
    // Another tab's device check cleared the account's copies: that is not a
    // sign-out. This tab checks its session again under a fresh fence.
    if (event.reconcile) {
      if (session.getSnapshot().accountId === event.accountId) session.retry();
      return;
    }
    session.adoptInvalidation(event.accountId);
  });

  return { session, device };
}
