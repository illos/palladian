# Notes accounts — independent review, round 2

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commit c9972b1 and the feature diff against aec969e. Recorded verbatim below; the response is in `notes-accounts-implementation.md`.

**Accounts: CHANGES REQUIRED**

- **A1 — fixed for partial failures.** `finishReset` now performs password, link, session, reset-record and agent changes in one mutation. The rollback test passed. Nested component calls participate in the transaction, consistent with the installed SDK and Convex's transaction guidance. A separate concurrent-login bypass remains: B1.
- **A2 — fixed.** The ceremony guard prevents stale verification from storing credentials. Additional probes passed for both button and autofill ceremonies when another tab signs in while verification is in flight.
- **A3 — fixed for credential replacement.** Both reset and invitation continuations use `signInAfter`. Supersession before and during automatic sign-in preserved the newer credentials and prevented activation. Completion reporting still needs B5.

1. **B1 — blocker — An in-flight old-password login can survive reset.** `passwords.ts:112`, `auth.ts:24`. Reproduced with the installed Better Auth handlers and `convex-test`: pause login after reading the old credential, complete reset, then resume login. It creates a valid session **after** the reset and successfully reads protected account data. Deleting existing sessions cannot fence a login that has already read the old password. **Fix:** revalidate the credential/reset generation used for password verification inside the session-creation transaction. Comparing session creation time alone is insufficient. Add this interleaving as a regression test.

2. **B2 — blocker — A stale reset-status response can erase a newer session's copies.** `auth-service.ts:100`. Tab A receives "no session" and starts `resetSince`. Tab B signs in successfully and records its newer session. A's delayed `true` response still returns `revoked`; its controller clears the shared account cache. Reproduced using the actual auth service and `SessionController`. The raw query is outside the Better Auth request guard, and only the original abort signal is checked afterward. **Fix:** bind the entire check to the authentication intent and recorded session/cache generation. Reject superseded answers before publishing revocation and authorizing cleanup.

3. **B3 — blocker — Reauthentication or missing metadata bypasses D98 cleanup.** `auth-service.ts:91`. A device signs in again before learning about a reset. The successful check overwrites `sessionBegan` and returns `ready` without checking whether its existing copies and drafts predate that reset. Reproduced: zero reset queries, old timestamp overwritten. Those drafts can subsequently synchronize. Devices without the new record also return `expired` without checking; the report acknowledges this limitation, and a test explicitly expects it. D98 contains no such exception. **Fix:** retain an account-scoped cache revocation baseline independently of the current login. Resolve outstanding reset cleanup before activating or replaying old drafts, and provide a migration path for existing caches without that baseline.

4. **B4 — blocker — The resetting device can delete its own unsaved work.** `pages.tsx:624`, `auth-service.ts:100`. Reset commits, but its action response is delayed. A renewal check runs on the resetting device, discovers the deleted session and reset, and clears its drafts. The exemption written by the page arrives too late. Reproduced with the actual service/controller; cleanup ran without settlement/export. Another tab on that device can trigger the same ordering. **Fix:** establish a coordinated, server-verifiable resetting-device exemption before cleanup can run; reconcile delayed or lost reset responses across tabs. A timestamp update after receiving success is insufficient.

5. **B5 — should-fix — Successful recovery can be reported as failure.** `sign-in-flow.ts:103`, `pages.tsx:644`. When another login supersedes an already-started automatic sign-in, the installed transport rejects. Reproduced: `signInAfter` throws instead of returning `superseded`. The page's outer catch consequently presents an error after the password reset has committed; retrying uses a consumed link. Invitation creation has the same structure. **Fix:** preserve the completed backend outcome separately and catch automatic-sign-in failures, showing successful recovery/account creation with a sign-in link.

6. **B6 — should-fix — `resetSince` exposes more than one bit of account history.** `account.ts:38`. Anyone holding an account ID can vary unauthenticated `since` values to reconstruct its latest reset timestamp and monitor subsequent resets. Opaque IDs limit discovery but do not bind callers to a particular device or session. **Fix:** use a device-scoped revocation proof with a server-bound baseline, rather than accepting arbitrary account/timestamp pairs.

Verification:

- Backend: **53 tests passed**.
- Worker: **74 tests passed**.
- App: **typecheck passed; 20 session and 99 unit tests passed**.
- Additional read-only, in-memory probes reproduced B1–B4 and B5's rejection, and verified A2/A3 credential fencing. Transport/authenticator behavior was simulated; B1 used actual Better Auth handlers with an in-memory component database and mocked JWT identity.
- The new tests meaningfully assert rollback and the original authentication races. They omit the reproduced orderings above. I did not independently rerun the reported mutation-testing experiments.
- D99's checked-in configuration is consistent: custom domain, disabled `workers.dev`, matching Worker origin/issuer, and documented Convex environment alignment. No stale former production origin remained in the tracked app/backend/edge files searched.
- No deployed Convex/Worker, production migration, inbox delivery, browser, Safari or real-iPhone verification performed. Production environment values remain unverified.
- Worktree remained clean; no code edits, commits, pushes or deployments.
