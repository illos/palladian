# Notes accounts — independent review, round 7

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit d9464a4 and the feature diff against aec969e. Recorded verbatim below. After this round the owner chose to ship the release without the D98 device wipe ("Ship now, wipe later", 2026-10-18); the wipe work, including these findings, continues on branch `feat/notes-device-wipe`.

**Accounts: CHANGES REQUIRED**

F1–F3 status:

- **F1 — resolved for the reported stale-clear case.** `cache.ts:645` checks the expected lifecycle before hiding content or forgetting drafts. The regression test detects removal of this protection. Lock ownership has separate failures described in G2.
- **F2 — not resolved completely.** The first controller cleanup carries the checked lifecycle, but retries can lose it and delete newer drafts (G1).
- **F3 — resolved for tabs running this version.** Reconciliation messages trigger a fresh fenced check. The integration test covers an in-flight check; an additional probe confirmed that an explicitly signed-out tab stays signed-out. Older tabs remain incompatible with this distinction (G3).

1. **G1 — blocker — Retried revocation cleanup loses its lifecycle.** `session-wiring.ts:93`, `cache.ts:645`. The wiring consumes `checkedRevocation` before cleanup succeeds, while the cache creates its operation only after the preliminary lifecycle read. Reproduced: the device check clears lifecycle 0; another tab activates lifecycle 1 and saves a draft; the controller's preliminary read fails. After reauthentication, pending cleanup retries with the same operation ID but **without a lifecycle**. Because that operation was never registered, it adopts lifecycle 1 and deletes the new draft. A second probe reproduced deletion when a new check superseded cleanup while its preliminary read was paused, without a storage error. **Suggested fix:** retain cleanup authority by operation ID across failures and supersession, including failures before operation registration. Alternatively, pass completed cleanup explicitly to the controller and eliminate the duplicate clear. Add both retry orderings as regressions.

2. **G2 — should-fix — Preliminary lifecycle checking can leak the account lock.** `cache.ts:646`, `cache.ts:678`. Two cases reproduced using actual cache code and Node's Web Locks: a rejected preliminary account read leaves the lock held with zero registered operations, so nothing retries or releases it; two concurrent lifecycle-bound calls using the same operation ID both return `true`, but the second acquires another hold and returns the completed operation's result without releasing it. Another store then rejects activation with "Another tab is still clearing this account." Waiting for `lifecyclesLoaded` introduces no apparent circular dependency, but it occurs inside this incompletely managed ownership interval. **Suggested fix:** coalesce acquisition/initialization per operation and explicitly manage temporary holds through every failure and completed-operation return. Preserve holds belonging to other unfinished operations.

3. **G3 — note — Older tabs still interpret reconciliation as sign-out.** `cache.ts:718`. The preceding version ignores `reconcile` and calls `adoptInvalidation`. During a mixed-version rollout, a new tab's reconciliation therefore still strands an older tab at signed-out. **Suggested fix:** provide or document an update/reload requirement for older tabs; the new field alone does not provide backward compatibility.

Verification:

- Backend: **59 tests passed**.
- Worker: **74 tests passed**.
- Frontend: **typechecking passed; 20 session tests and 118 unit tests passed**.
- In-memory reversions of F1, F2 and F3 each failed their corresponding new regression test. Those tests meaningfully cover the original findings, but miss G1–G2.
- Existing cached-startup, transport-failure preservation, expiry, account-isolation, late-response and logout tests passed. An additional probe confirmed voluntary logout clears newer drafts after successful revocation handling and reauthentication.
- Additional probes used actual cache/controller/wiring modules, fake IndexedDB, native Node Web Locks and simulated transport. No deployed services, inbox delivery, browser/authenticator, Safari, real iPhone or actual crash recovery were exercised.

The worktree remained clean at `d9464a4`. No files, configuration, commits or deployments were changed.
