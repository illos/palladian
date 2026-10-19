**Accounts: ACCEPTED**

No blocker or should-fix findings in `aec969e..6ec2eca`, including the trimming commit `6ec2eca`.

1. **H1 — note — Live release verification remains pending.** `notes-accounts-implementation.md:47`. The final release's request → inbox → reset → sign-in flow and passkeys on the final hostname have not been exercised against deployed services. Local tests simulate delivery and authenticators. **Suggested fix:** complete those documented deployment checks, including the second device retaining cached notes after reset. No code change requested.

Verified through release-diff review, comparison with the base, review of rounds 1–7, and local tests:

- **Wipe removal is complete:** no device records, secrets, status/bind calls, reset exemptions, reconciliation wiring, or wipe-specific cache extensions remain. `cache.ts` exactly matches the base; `main.tsx` adds only reset-page routing. `resetEpoch` remains for the old-password sign-in fence.
- **A1, A2, A3, B1 and B5 remain addressed:** reset effects commit together; stale password sign-ins are fenced; superseded passkey ceremonies cannot replace newer credentials; reset/invitation completion survives failed automatic sign-in.
- **Session/cache behavior is preserved:** cached startup precedes authentication, transport failures preserve content, expiry retains notes and drafts, and existing account-isolation, late-response, logout and access-revocation protections remain.
- Sign-in screens, passkey settings, invitation email, relay validation and checked-in D99 hostname configuration remain intact.
- The release documentation accurately distinguishes immediate server-session invalidation from the sign-in prompt appearing on the next check, and explicitly defers wiping.

Checks independently run:

- Backend: **55 tests passed**.
- Worker: **74 tests passed**.
- Frontend: **typecheck passed; 20 session tests and 94 unit tests passed**.
- Diff whitespace check passed; worktree remained clean.

Backend tests used in-memory Convex components; Worker tests used simulated bindings; frontend tests used simulated transport, fake IndexedDB and a fake authenticator. The documented non-failing storage-listener warning recurred.

I did not run browser tests, deployed-service checks, production migration, inbox delivery, Safari/WebKit or real-iPhone checks. No source edits, commits, pushes or deployments were performed.
