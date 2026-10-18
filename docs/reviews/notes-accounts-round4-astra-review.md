# Notes accounts — independent review, round 4

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit 6ce7290 and the feature diff against aec969e. Recorded verbatim below; the response is in `notes-accounts-implementation.md`.

**Accounts: CHANGES REQUIRED**

C1–C8 status:

- **C1 — not resolved.** Ordinary persisted-copy cleanup now precedes binding, including a lost binding response. D1 and D3 still allow acknowledgement without clearing existing drafts.
- **C2 — not resolved.** Both delayed-status branches now reject superseded answers, but the token acquisition inside binding and the early `expired` return remain unguarded (D1, D4).
- **C3 — resolved.** `auth-service.ts:144` checks the displayed account before settling a switch. Its regression test fails when this check is removed.
- **C4 — resolved.** `devices.ts:84` preserves an outstanding cleanup obligation and leaves unknown browsers unknown. Removing the epoch comparison fails the regression test.
- **C5 — not resolved.** Transactional secret creation makes concurrent tabs agree, but storage errors bypass validation, and the version upgrade discards the previous identity (D2, D5).
- **C6 — resolved.** `devices.ts:102` queries the requested account and then its exact device record; the twenty-account truncation is gone.
- **C7 — resolved.** `devices.ts:51` bounds registration at 200, retires only current records, and refuses insertion when all are behind. Increasing the limit fails the regression test.
- **C8 — resolved for genuinely empty browsers.** They bind and open without unnecessary revocation. The incomplete detection of memory-only copies is D3.

New findings:

1. **D1 — blocker — Binding can acknowledge the wrong account after a concurrent sign-in.** `auth-service.ts:108`. A check confirms that A has no copies. Before `auth.convex.token()` acquires the authentication lock, another tab completes sign-in to B. The helper obtains B's token and calls `devices.bind`, marking B current without inspecting B's revoked drafts. The subsequent `stale()` check returns `transient`, after the mutation has committed. Reproduced with the installed client and a simulated other-tab credential update at lock acquisition: only A's copies were checked; B was bound and its cleanup obligation disappeared. **Fix:** carry the captured authentication intent and expected account through token acquisition; revalidate both before sending the mutation. Have the mutation reject an expected-account mismatch.

2. **D2 — blocker — Failure to store the device secret authorizes existing copies.** `auth-service.ts:83`, `auth-service.ts:141`. A failed IndexedDB transaction does not establish that the browser has no copies. During first secret creation, a quota error can leave previously cached drafts intact. `secret()` converts the error to `null`; the authenticated branch returns `ready` without checking revocation. Fault injection against the actual `NotesStore` reproduced `ready`, zero device-status requests, successful cache activation, and a surviving persisted draft. **Fix:** treat inability to establish device identity as transient and keep synchronization paused while preserving viewing. Any storage-free mode needs an explicit guarantee that it cannot expose or replay existing copies.

3. **D3 — blocker — Memory-only recovery drafts are omitted from cleanup detection.** `cache.ts:850`. `writeDraft()` deliberately retains an editor snapshot in memory when persistence fails. `hasCopies()` counts only IndexedDB rows. With empty persistent tables and an unsaved memory snapshot, a browser behind a reset is therefore bound as current without clearing that draft. Reproduced with a failed draft write: `unsavedWork()` reported one draft, `hasCopies()` returned false, and the service bound the browser and returned `ready`. **Fix:** include recovery snapshots and pending writes in the cleanup decision. Coordinate that decision with account fencing across tabs so outstanding writes cannot invalidate the empty-cache observation.

4. **D4 — should-fix — The early expiry result can supersede a newer sign-in.** `auth-service.ts:162`. A tab receives "no session" and waits for its device secret. Another tab signs in during that wait. When the original tab has no displayed account, it returns `expired` without checking `stale()`. The controller accepts expiry and does not schedule another check. Reproduced with the installed client: a newer credential existed, but the older check returned `expired`. **Fix:** apply the supersession guard before this return and add the delayed-secret ordering to the tests.

5. **D5 — should-fix — The version-4 upgrade unnecessarily loses a valid device identity.** `cache.ts:137`, `cache.ts:836`. A version-4 browser can already have a current server record, its secret in `palladian.notes.device.v1`, and unsaved drafts. Version 5 preserves those drafts but generates a different secret. Its next authenticated check reports `revoked` and initiates destructive cleanup despite no password reset. A synthetic v4→v5 upgrade reproduced this exact result. **Fix:** transactionally adopt a valid legacy secret when initializing the new table. Test upgrades with both current and behind server records.

Verification:

- Backend: **59 tests passed**.
- Worker: **74 tests passed**.
- Frontend: **typecheck passed; 20 session tests and 109 unit tests passed**.
- In-memory mutation checks produced assertion failures when removing protections for **C1, C2, C3, C4, C5, C7 and C8**. These tests have meaningful coverage, but omit the reproduced orderings above. C6 lacks a dedicated many-account regression; the all-behind registration-cap case is also untested.
- Additional probes used the installed auth client, simulated transport and cross-tab storage changes, and actual `NotesStore` code over fake IndexedDB. They reproduced D1–D5 without editing files.
- Cached rendering still precedes authentication. Existing transport-failure, account-isolation and cache-fencing tests pass. Passkey ceremony tests pass with a simulated authenticator; device reconciliation remains subject to these findings regardless of sign-in method.
- `bind` requires a live human session and derives its account server-side; `status` requires the matching secret/account pair. D1 exposes unintended acknowledgement through those otherwise authenticated operations.
- No deployed services, actual email delivery, production migration, browser, Safari or real iPhone were independently exercised. Worktree remained clean at `6ce7290`; no edits, commits, pushes or deployments.
