# Notes accounts — independent review, round 6

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit e368cf0 and the feature diff against aec969e. Recorded verbatim below; the response is in `notes-accounts-implementation.md`.

**Accounts: CHANGES REQUIRED**

- **E1 — not resolved completely.** The captured lifecycle protects persisted drafts in the original two-tab test. However, rejected clears still discard local memory drafts, and no-session revocation starts a second, unfenced clear (F1–F2).
- **E2 — resolved for the initiating tab.** Suppressing its own invalidation allows reconciliation and the fresh-fence recheck to complete, including an account hint with an empty cache. Another tab can still become permanently signed-out during that reconciliation (F3).
- **E3 — resolved for the reported omission.** Known-behind status now clears independently of local copy counts; the integration test confirms another tab's memory-only draft is removed. The subsequent controller cleanup introduces F2.

1. **F1 — blocker — A refused clear still destroys memory-only drafts.** `cache.ts:637`, `cache.ts:662`. `clearAccount` calls `hideAccount` before checking the captured lifecycle. That immediately forgets recovery drafts, blocks local viewing and emits invalidation. A delayed clear targeting lifecycle 0 therefore damages lifecycle 1 before returning `false`. A direct cache probe reproduced this: one newer memory-only draft became zero, with the local account blocked despite its persistent account remaining unblocked. **Suggested fix:** validate cleanup authority under the account lock before destructive memory changes or invalidation. A superseded clear must leave the current lifecycle untouched. Add a regression covering memory-only recovery in the tab receiving the stale decision.

2. **F2 — blocker — No-session revocation performs a second clear without its lifecycle.** `auth-service.ts:196`, `session.ts:230`, `session-wiring.ts:73`. The service completes the lifecycle-bound clear and returns `revoked`. The controller then starts another operation through `clearAccount(accountId, operation)`. With an account hint but no account row when the store opened, its remembered lifecycle is undefined. Pause this continuation, let another tab sign in, activate a newer lifecycle and write a draft, then resume: the second clear adopts the newer lifecycle and deletes that draft. The integration probe reproduced deletion and the newer tab becoming signed-out. **Suggested fix:** pass an explicit completed-cleanup result to the controller, or preserve the original operation and lifecycle through controller handling. Do not create fresh cleanup authority after cleanup has already completed.

3. **F3 — should-fix — Another tab's reconciliation strands a valid session at signed-out.** `session-wiring.ts:95`. Two tabs display the same hinted account. Hold A's device-status response while B clears, binds and activates. A receives B's invalidation while outside its own `reconciling` set, calls `adoptInvalidation`, aborts its check and becomes signed-out. B succeeds, but A refuses passive retry. Reproduced with the real store, controller and wiring. **Suggested fix:** distinguish reconciliation invalidations from explicit sign-out and coordinate a fresh fenced check in affected tabs. Preserve explicit-logout protection rather than suppressing every account invalidation.

Verification:

- Backend: **59 tests passed**.
- Worker: **74 tests passed**.
- Frontend: **typecheck passed; 20 session tests and 115 unit tests passed**.
- Additional probes used actual application modules, fake IndexedDB and simulated transport. They reproduced F1–F3.
- In-memory mutation checks made the integration assertions fail when removing E1's lifecycle argument, removing E2's suppression, or restoring ordinary expiry for E3. Removing only E3's service-level clear still passed the integration test because the controller clears again—the duplication behind F2.
- Existing tests for immediate cached viewing, transport-error preservation, account isolation, logout and passkey supersession pass. These do not establish correctness for the additional orderings above.
- Device endpoints retain live-human authorization, expected-account validation, secret-scoped status and bounded registration. No additional cross-account authorization bypass was found.

No deployed services, inbox delivery, real browser/authenticator, Safari or iPhone were exercised. Crashes and suspension were assessed through code and simulated pauses, not actual process termination. The worktree remained clean at `e368cf0`; no files, configuration or deployments were changed.
