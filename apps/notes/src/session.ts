export type SessionStatus =
  "connecting" | "ready" | "retrying" | "expired" | "revoked" | "signed-out";
export interface SessionSnapshot {
  status: SessionStatus;
  accountId: string | null;
  generation: number;
  error: string | null;
}
/** Only an authoritative service response may return expired/revoked. */
export type SessionCheck =
  | { kind: "ready"; accountId: string }
  | { kind: "expired" }
  | { kind: "revoked"; accountId: string }
  | { kind: "transient"; message: string };
export interface SessionService {
  check(signal: AbortSignal): Promise<SessionCheck>;
  signOut?(signal: AbortSignal): Promise<void>;
}
/** Stores only an account pointer and explicit-logout intent, never credentials. */
export interface AccountHintStore {
  read(): {
    accountId: string | null;
    signedOut: boolean;
    pendingCleanup?: string | null;
  };
  remember(accountId: string): void;
  signedOut(accountId?: string): void;
  hideForCleanup(accountId: string): void;
}
export interface SessionOptions {
  service: SessionService;
  hints: AccountHintStore;
  clearAccount(accountId: string): Promise<void>;
  prepareLogout?: () => Promise<boolean>;
  onAccountReady?: (
    accountId: string,
    isCurrent: () => boolean,
  ) => void | Promise<void>;
  schedule?: (callback: () => void, delay: number) => () => void;
  deadlineMs?: number;
  renewalMs?: number;
}
const defaultSchedule = (callback: () => void, delay: number) => {
  const id = setTimeout(callback, delay);
  return () => clearTimeout(id);
};

/** Display identity and remote readiness are deliberately separate. */
export class SessionController {
  private readonly options: SessionOptions;
  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private running = false;
  private pending = false;
  private request = 0;
  private abort: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;
  private failures = 0;
  private logoutPending = false;
  private pendingCleanup: string | null = null;

  constructor(options: SessionOptions) {
    this.options = options;
    let hint: ReturnType<AccountHintStore["read"]>;
    try {
      hint = options.hints.read();
    } catch {
      hint = { accountId: null, signedOut: false };
    }
    this.pendingCleanup = hint.pendingCleanup ?? null;
    this.snapshot = {
      status: hint.signedOut ? "signed-out" : "connecting",
      accountId: hint.signedOut ? null : hint.accountId,
      generation: 0,
      error: null,
    };
  }
  getSnapshot = (): SessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    if (
      this.snapshot.status !== "signed-out" &&
      this.snapshot.status !== "revoked"
    )
      this.check();
  }
  stop(): void {
    this.running = false;
    this.fence();
  }
  /** Other tabs' explicit cleanup must fence callbacks as well as storage. */
  adoptInvalidation(accountId: string): void {
    if (this.snapshot.accountId !== accountId) return;
    this.fence();
    this.pendingCleanup = accountId;
    this.update({ accountId: null, status: "signed-out", error: null });
  }
  /** Explicit retry also serves successful sign-in; passive startup honors logout. */
  retry(options: { afterSignIn?: boolean } = {}): void {
    if (!this.running || this.logoutPending) return;
    if (
      (this.snapshot.status === "signed-out" ||
        this.snapshot.status === "revoked") &&
      !options.afterSignIn
    )
      return;
    this.fence();
    this.update({ status: "connecting", error: null });
    this.check();
  }
  private fence(): void {
    this.request += 1;
    this.pending = false;
    this.abort?.abort();
    this.cancelTimer?.();
    this.cancelDeadline?.();
    this.abort = null;
    this.cancelTimer = null;
    this.cancelDeadline = null;
    this.update({ generation: this.snapshot.generation + 1 });
  }
  private later(delay: number): void {
    this.cancelTimer?.();
    this.cancelTimer = (this.options.schedule ?? defaultSchedule)(() => {
      this.cancelTimer = null;
      this.check();
    }, delay);
  }
  private fail(): void {
    this.failures += 1;
    this.update({
      status: "retrying",
      error: "Connection unavailable. Your cached notes are still available.",
    });
    this.later(Math.min(30_000, 500 * 2 ** Math.min(this.failures - 1, 6)));
  }
  private check(): void {
    if (!this.running || this.pending || this.logoutPending) return;
    this.pending = true;
    const request = ++this.request;
    const controller = new AbortController();
    this.abort = controller;
    const current = () => this.running && this.request === request;
    const finish = () => {
      this.pending = false;
      this.cancelDeadline?.();
      this.cancelDeadline = null;
      this.abort = null;
    };
    this.cancelDeadline = (this.options.schedule ?? defaultSchedule)(() => {
      if (!current()) return;
      finish();
      this.request += 1;
      controller.abort();
      this.fail();
    }, this.options.deadlineMs ?? 8_000);
    void Promise.resolve()
      .then(() => this.options.service.check(controller.signal))
      .then(async (result) => {
        if (!current()) return;
        finish();
        if (result.kind === "transient") {
          this.fail();
          return;
        }
        if (result.kind === "expired") {
          this.update({ status: "expired", error: null });
          return;
        }
        if (result.kind === "revoked") {
          const previous = this.snapshot.accountId;
          // A response for a different identity is not authority to erase this account.
          if (previous && previous !== result.accountId) {
            this.fail();
            return;
          }
          this.fence();
          const revocationGeneration = this.snapshot.generation;
          try {
            this.options.hints.signedOut(result.accountId);
          } catch {
            /* cache cleanup still runs */
          }
          this.update({ status: "revoked", accountId: null, error: null });
          this.pendingCleanup = result.accountId;
          try {
            await this.options.clearAccount(result.accountId);
            if (
              this.snapshot.generation === revocationGeneration &&
              this.snapshot.status === "revoked"
            ) {
              this.pendingCleanup = null;
              this.options.hints.signedOut();
            }
          } catch {
            if (
              this.snapshot.generation === revocationGeneration &&
              this.snapshot.status === "revoked"
            )
              this.update({
                error:
                  "Local cleanup failed. Cached content remains hidden; retry cleanup before using this device.",
              });
          }
          return;
        }
        if (!result.accountId) {
          this.fail();
          return;
        }
        this.failures = 0;
        const previous = this.snapshot.accountId;
        if (previous && previous !== result.accountId)
          this.pendingCleanup = previous;
        if (this.pendingCleanup) {
          const cleanup = this.pendingCleanup;
          this.fence();
          const generation = this.snapshot.generation;
          this.update({ accountId: null, status: "connecting" });
          try {
            this.options.hints.hideForCleanup(cleanup);
            await this.options.clearAccount(cleanup);
          } catch {
            if (this.snapshot.generation === generation)
              this.update({ error: "Account cleanup failed. Please retry." });
            return;
          }
          if (!this.running || this.snapshot.generation !== generation) return;
          this.pendingCleanup = null;
        }
        const generation = this.snapshot.generation;
        try {
          await this.options.onAccountReady?.(
            result.accountId,
            () =>
              this.running &&
              this.snapshot.generation === generation &&
              !this.logoutPending,
          );
        } catch {
          if (this.running && this.snapshot.generation === generation)
            this.fail();
          return;
        }
        if (!this.running || this.snapshot.generation !== generation) return;
        try {
          this.options.hints.remember(result.accountId);
        } catch {
          /* display and remote identity do not require writable localStorage */
        }
        this.update({
          status: "ready",
          accountId: result.accountId,
          error: null,
        });
        this.later(this.options.renewalMs ?? 60_000);
      })
      .catch(() => {
        if (!current()) return;
        finish();
        this.fail();
      });
  }
  async logout(): Promise<boolean> {
    if (this.logoutPending) return false;
    this.logoutPending = true;
    this.fence();
    const logoutGeneration = this.snapshot.generation;
    try {
      if (this.options.prepareLogout && !(await this.options.prepareLogout())) {
        this.logoutPending = false;
        this.retry();
        return false;
      }
      if (this.snapshot.generation !== logoutGeneration) return false;
      const accountId = this.snapshot.accountId;
      this.fence();
      // Persist intent before async cleanup so a surviving server cookie cannot auto-reopen.
      try {
        this.options.hints.signedOut(accountId ?? undefined);
      } catch {
        this.update({
          error:
            "Unable to persist sign-out. Please resolve local storage before signing out.",
        });
        return false;
      }
      this.update({ status: "signed-out", accountId: null, error: null });
      this.pendingCleanup = accountId;
      try {
        if (accountId) await this.options.clearAccount(accountId);
        this.pendingCleanup = null;
        this.options.hints.signedOut();
      } catch {
        this.update({
          error: "Local cleanup failed. Cached content remains hidden.",
        });
        return false;
      }
      const abort = new AbortController();
      let cancel: (() => void) | undefined;
      const deadline = new Promise<void>((_, reject) => {
        cancel = (this.options.schedule ?? defaultSchedule)(() => {
          abort.abort();
          reject(new Error("Sign-out transport deadline"));
        }, this.options.deadlineMs ?? 8_000);
      });
      try {
        await Promise.race([
          Promise.resolve().then(() =>
            this.options.service.signOut?.(abort.signal),
          ),
          deadline,
        ]);
      } catch {
        /* locally signed-out intent blocks passive restoration */
      } finally {
        cancel?.();
      }
      return true;
    } finally {
      this.logoutPending = false;
    }
  }
}

export function browserAccountHints(
  storage: Pick<Storage, "getItem" | "setItem">,
): AccountHintStore {
  const key = "palladian.notes.account-hint.v1";
  return {
    read() {
      const raw = storage.getItem(key);
      if (!raw) return { accountId: null, signedOut: false };
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object")
        return { accountId: null, signedOut: false };
      const record = value as Record<string, unknown>;
      return {
        accountId:
          typeof record.accountId === "string" ? record.accountId : null,
        signedOut: record.signedOut === true,
        pendingCleanup:
          typeof record.pendingCleanup === "string"
            ? record.pendingCleanup
            : null,
      };
    },
    remember(accountId) {
      storage.setItem(key, JSON.stringify({ accountId, signedOut: false }));
    },
    signedOut(accountId) {
      storage.setItem(
        key,
        JSON.stringify({
          accountId: null,
          signedOut: true,
          pendingCleanup: accountId ?? null,
        }),
      );
    },
    hideForCleanup(accountId) {
      storage.setItem(
        key,
        JSON.stringify({
          accountId: null,
          signedOut: false,
          pendingCleanup: accountId,
        }),
      );
    },
  };
}
