# Notes accounts — independent review, round 5

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit 944e702 and the feature diff against aec969e. Recorded verbatim below; the response is in `notes-accounts-implementation.md`.

**Accounts: CHANGES REQUIRED**

D1–D5 status:

- **D1 — resolved.** The post-token guard prevents superseded binding; the mutation rejects an account mismatch. Evidence: `auth-service.ts:114`, `devices.ts:127`, the lock-ordering regression and backend mismatch test.
- **D2 — resolved.** Device-secret failure now returns `transient`, preventing activation while preserving cached viewing. Evidence: `auth-service.ts:145`, `auth-service.ts:186`.
- **D3 — not resolved completely.** `cache.ts:869` correctly counts this tab's memory drafts, and authenticated reconciliation clears before binding. Other-tab recovery remains unhandled in the no-session path (E3), and integration introduces E1–E2.
- **D4 — resolved.** The early expiry result immediately follows the session request and checks supersession. Evidence: `auth-service.ts:176`.
- **D5 — resolved.** Secret initialization transactionally adopts a valid legacy value. Evidence: `cache.ts:854`.

1. **E1 — blocker — A delayed device-status response can erase newly created drafts.** `auth-service.ts:165`, `cache.ts:659`. Two tabs check the same session on an initially unknown browser. Hold tab A's "unknown" response; let B clear, bind, activate and save a fresh draft. Release A's response: A sees B's new copies and reports revocation. Its clear can adopt the _new_ lifecycle because A had no previously recorded lifecycle. Reproduced: the fresh draft was deleted, A became `revoked`, and B became `signed-out`, without any password reset or newer authentication intent. The activation fence protects `ready`, but does not protect this destructive result. **Suggested fix:** bind cleanup authority to the account lifecycle captured before the status request; atomically reject obsolete clears before hiding or deleting content. Retry under a fresh fence when another tab has reconciled.

2. **E2 — should-fix — Reconciliation aborts itself when the displayed account matches.** `main.tsx:116`, `auth-service.ts:169`. With an account hint, an empty cache and an unknown/behind device record, `devices.clear()` synchronously emits invalidation. `adoptInvalidation()` fences and aborts the initiating check, then sets `signed-out`. Binding never runs, `reconciled` never reaches the fresh-fence loop, and passive retry is refused. Reproduced with the actual store and controller. **Suggested fix:** make reconciliation a controller-owned transition that retains cleanup fencing and explicitly resumes checking afterward, without interpreting its own cleanup notification as voluntary sign-out. Cover both password and passkey activation.

3. **E3 — blocker — Confirmed revocation leaves another tab's memory-only drafts intact without a session.** `auth-service.ts:180`. Tab B retains a recovery draft after a failed IndexedDB write; persistent account tables are empty. Tab A checks the displayed account after a remote reset and receives `{ known: true, behind: true }`. A's `hasCopies()` cannot see B's memory, so it returns ordinary `expired` without clearing or broadcasting. Reproduced: B's draft survived after this browser contacted the server and learned of revocation. **Suggested fix:** known-behind status must initiate coordinated account cleanup independently of this tab's copy count, with the lifecycle protection described in E1.

Verification:

- Backend: **59 tests passed**.
- Worker: **74 tests passed**.
- Frontend: **typecheck passed; 20 session tests and 113 Vitest tests passed**.
- Additional read-only probes reproduced E1–E3 using actual authentication-service, cache and controller code, fake IndexedDB, simulated transport, and a reproduction of the boot wrapper.
- In-memory mutation probes confirmed that the corresponding D1, D2, tab-local D3 and D5 assertions detect removal of their protections. D4's delayed-request test also benefits from the transport's guard; it does not independently prove the final service guard is necessary.
- The device tests mock `clear` as set deletion, omitting cache notifications and controller integration. They therefore miss E1–E3.
- Cached rendering still precedes authentication; existing transport-failure, isolation and passkey-supersession tests pass. Clear-before-bind handles the tested lost binding response; the boot adapter rejects `clearAccount(false)` before binding.
- Device functions retain live-human authorization, expected-account validation, secret-scoped status and bounded registration. No additional cross-account authorization bypass was found.

No deployed services, email delivery, real browser/authenticator, Safari or iPhone were exercised. Crash recovery was assessed through code and simulated ordering, not real process termination. Worktree remained clean at `944e702`; no files, configuration or deployments were changed.
