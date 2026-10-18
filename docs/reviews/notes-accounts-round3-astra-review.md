# Notes accounts — independent review, round 3

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit 4b3580f and the feature diff against aec969e. A first request for this round was stopped by the reviewer service's safety filter before any review was produced; this is the report from the resent request, recorded verbatim. The response is in `notes-accounts-implementation.md`.

**Accounts: CHANGES REQUIRED**

- **B1 — resolved.** The hook reads the reset epoch before re-verifying the password; `authFunctions` wires the session trigger into the component's creation transaction. Both reset interleavings pass. Removing either the recheck or trigger wiring caused regression-test assertion failures. `credentialEpoch` persists internally but was absent from the tested `/get-session` response.
- **B2 — resolved for the reported no-session race.** The supersession check rejects the delayed revocation answer; removing it fails its regression test. The live-session branch has a separate omission: C2.
- **B3 — not resolved.** Device records improve ordinary reauthentication, but C1, C3–C6 still permit required cleanup to be skipped.
- **B4 — resolved for the reported reset-response race.** The resetting browser's exemption commits with the reset, before its response arrives. Separate problems remain with outstanding revocations and device identity: C4–C5.
- **B5 — resolved.** Automatic-sign-in rejection preserves the completed operation's success message. Restoring the uncaught implementation fails the regression test.
- **B6 — resolved.** Arbitrary account/timestamp queries are gone. Status requires possession of the device secret; binding derives the account from a live human session. Storage growth remains C7.

1. **C1 — blocker — Binding acknowledges cleanup before cleanup starts.** `auth-service.ts:123`. A browser with revoked copies signs in. `devices.bind` commits, but its response is lost. `check()` returns transient, so the controller never records pending cleanup. On retry, status says current and the old drafts are activated. Reproduced with a committed-bind/lost-response simulation. A crash or another tab checking between binding and cleanup creates the same gap. **Fix:** durably fence the affected local cache before acknowledging its reset epoch. Complete deletion before advancing the server baseline, with retry-safe, account-and-epoch-specific acknowledgement.

2. **C2 — blocker — The existing-device success path accepts superseded responses.** `auth-service.ts:118`. A check obtains A's session and waits for device status. Another tab signs in as B. The delayed "current" result still returns `ready(A)` because this branch skips `superseded()`. Reproduced with the installed auth client. The controller's local request generation does not detect every other-tab authentication change. **Fix:** validate the captured authentication intent after every awaited boundary and before every ready result or binding mutation.

3. **C3 — blocker — Switching accounts bypasses revocation of the displayed account.** `auth-service.ts:115`. The browser displays A's cached drafts, A is remotely reset, and the browser authenticates B before checking. Status contains A's revocation, but the live-session branch examines only B. The controller follows ordinary account-switch settlement: it can offer export or retain A's drafts when settlement is declined. Reproduced with the actual service and `SessionController`; cleanup was never called. **Fix:** reconcile the displayed account's revocation independently of the authenticated account before ordinary switch settlement or activation.

4. **C4 — blocker — A subsequent reset cancels an earlier unfulfilled cleanup obligation.** `passwords.ts:140`. Device X resets the account while Y has offline drafts. Before Y processes that revocation, Y performs another reset. `finishReset` unconditionally advances Y's record, changing its status from revoked to current without clearing the drafts revoked by X's reset. Reproduced through the real reset handlers in `convex-test`. **Fix:** exempt the resetting browser from the new reset while preserving any previously outstanding revocation. A stale browser must complete that earlier cleanup before activation.

5. **C5 — blocker — Device identity can disappear independently of cached notes.** `auth-service.ts:15`. Losing the device-secret key while IndexedDB survives creates a new identity; reauthentication then binds it as a new browser and can reopen old drafts. Failure to store the secret explicitly bypasses device checking. Concurrent first calls can also return different secrets because creation is an unlocked read/create/write sequence. The storage-failure and interleaved-creation behaviors were reproduced. Starting on a new domain does not prevent later metadata loss. **Fix:** persist device identity with the cache lifecycle, create it transactionally across tabs, and reconcile existing caches when identity is missing. Storage failure must preserve viewing without silently authorizing stale-draft synchronization.

6. **C6 — should-fix — Status silently omits accounts after twenty records.** `devices.ts:47`. A browser with 21 account records receives only twenty, without a continuation indicator. An omitted revoked account is treated as ordinary expiry or as a new binding. Reproduced with 21 revoked records. **Fix:** query the specific account using the device secret, or paginate completely. An omitted result must not mean "no revocation."

7. **C7 — should-fix — Device registration permits unbounded persistent growth.** `devices.ts:71`. Any authenticated human can repeatedly bind fresh secrets, creating permanent rows without a quota, rate limit, or retirement mechanism. Arbitrary repeated insertion was verified. Callers cannot directly choose another account, but can grow storage under their own account indefinitely. **Fix:** bound registration and define retirement that preserves outstanding cleanup obligations.

8. **C8 — note — A device record does not establish that cached notes exist.** `auth-service.ts:125`. A browser used only for password recovery gets a record from `finishReset`. After a later reset elsewhere, its first successful sign-in is reported as revoked despite never having cached notes; another sign-in is required. **Fix:** distinguish cache generations from browser registration, or complete empty-cache reconciliation and activate the already-valid session.

Verification:

- Backend: **57 tests passed**.
- Worker: **74 tests passed**.
- App: **typecheck passed; 20 session tests and 103 unit tests passed**.
- Additional read-only, in-memory probes exercised the findings above. Four in-memory mutation checks confirmed meaningful regression coverage for the password recheck, trigger wiring, no-session supersession guard, and automatic-sign-in error handling.
- The device-client tests mock binding without updating server status or completing controller/cache cleanup. They therefore miss the critical acknowledgement ordering.
- Cached rendering still precedes authentication. Extra device calls delay activation, and transport failures remain transient; C1 concerns their committed server side effect, not direct cleanup on a network error.
- Passkey sessions are unstamped: a still-valid passkey can create a session after reset. Existing-device cache cleanup must therefore work independently of password authentication. No real-authenticator reset interleaving was exercised.
- No deployed services, production migration, email delivery, browser, Safari, or real iPhone were tested. Backend execution used in-memory Convex components; client transport/storage were simulated.
- Worktree remained clean at `4b3580f`. No code edits, commits, pushes, or deployments.
