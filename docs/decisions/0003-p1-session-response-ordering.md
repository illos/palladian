# ADR 0003 — P1 session response ordering

Date: 2026-09-10. Status: implemented for local development, **awaiting independent final acceptance**. Read `P1-implementation.md`, `P1-review.md`, and ADR 0002. P1 still requires the independently reviewed A03 automatic-resume result before downstream acceptance.

## Contract and reviewed scope

The original A07 assertion reproduced a delayed, already-committed A sliding response overwriting B's browser credential. The independent reviewer approved the bounded correction proposal, then identified two additional gaps in a cookie-only fix: Better Fetch invokes caller hooks before adapter hooks, and Better Auth's session atom independently writes the returned body/error. A third gap involved pending provider token promises. The parent authorized the expanded cancellation plumbing after this review; no auth lifetime, renewal, freshness, revocation, trust-origin or server identity contract changed.

The existing package patches now include runtime changes and must no longer be described as declaration-only:

- `@convex-dev/better-auth@0.12.5`: source and emitted runtime for the cross-domain client and React provider. Auth intents acquire an opaque, persisted ordering generation; each request also captures the session credential value. Sliding expiry metadata and JWT-cookie updates do not change identity. Stale requests abort with the fixed non-sensitive `AbortError` reason `Authentication request superseded`. Both initial dispatch and later response checks reread the current generation. Retries retain the original guard and intent. A current successful sign-in may commit its new cookie and advance its own captured credential while holding the storage lock.
- `@better-fetch/fetch@1.3.1`: ESM/CJS runtimes and corresponding option declarations. The optional typed synchronous `assertRequestCurrent` callback and the request abort signal are checked before dispatch, response/success/error/retry hooks, retries and final result delivery. This prevents stale body/error delivery through earlier caller callbacks, including identity changes during asynchronous parsing or hooks. Callers without the option retain normal fetch behavior plus standard abort checks.
- `better-auth@1.6.30`: the session atom treats only the precise superseded-auth `AbortError` as cancellation; it does not write the old error over the current atom. Other transport errors retain the supported library behavior. No generic error swallowing or new retry/refresh loop was introduced.

The provider now checks mounted state, current rendered session ID, and exact pending-promise identity before caching a result or clearing a current cache on failure. A finished older promise cannot clear a newer pending promise. It keeps the supported provider as the token-acquisition owner and adds no client action API or application refresh timer.

The parent's separate Runtime/Account corrections guard application callbacks after account changes/unmount. Their independent browser evidence is recorded by the reviewer, not claimed by this supplement.

## Cross-tab serialization and browser baseline

All adapter storage initialization and response commits use the same origin-scoped Web Lock name derived from the cookie storage prefix. The lock covers generation/read/check/write and library cache notifications only; it is never held across fetch, body parsing, or caller hooks. Async custom storage operations, where supplied, are awaited inside that storage transaction. Every cooperating adapter instance using a prefix must use this lock; direct writes or old unpatched clients are outside this guarantee.

Missing Web Locks fails before changing stored credentials, allowing the shell's existing connection/retry behavior to handle the error. There is no unsafe unlocked browser fallback, lock stealing, timeout logout, or server-wide revocation. Web Locks shipped in Safari 15.4, below the iOS 16.4 baseline in [ADR 0001](0001-runtime-and-auth.md) and the build targets ([WebKit release notes](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)). These facts do not replace actual iPhone verification.

The initial development candidate used `AbortSignal.any`; that API is newer than the browser baseline ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)). The final patch forwards the caller's original abort signal through a one-time listener to a native AbortController instead. Weak references avoid strongly retaining completed guards; in-flight guards remain available throughout later hooks and are pruned on subsequent dispatch or identity transition. No request guard is removed prematurely at adapter success.

## Verification and limits

`node scripts/check-auth-patch-source.mjs` passes. It strictly checks the two changed TypeScript runtime sources under the unchanged web TypeScript safety flags against the installed published dependency declarations. Only server-only type imports are redirected to the package's supported declarations for this check; it does not fabricate generated files or ignore diagnostics. Runtime JS was emitted with the pinned compiler; strict source checking is a separate required gate because the upstream source import graph contains unrelated declaration/source compatibility defects. Source and runtime logic are both included in the patch.

`node --test tests/auth-session-races.test.mjs` passes eleven tests using the actual installed Better Auth/adapter/Better Fetch pipeline, **mock network responses and storage**, and the actual Node 24 Web Locks implementation. Four initial tests failed against the uncorrected runtime; the same-session sliding control passed. Final cases cover:

1. Stale successful session body/caller callback after A→B.
2. Stale access-token body after A→B.
3. Empty→sign-in→logout→empty generation ordering.
4. Delayed signout after B.
5. Same-session renewal through another client without cancellation.
6. Account switch while the response body is streaming.
7. Stale unauthorized response preserving the current session atom.
8. Account switch inside an awaited caller success hook.
9. Another client switching during asynchronous JSON parsing without storage events.
10. Missing Web Locks retaining the device credential.
11. A retry retaining a single successful sign-in intent.

The actual local Better Auth/Convex service and Chromium A07 test passed after a forced Vite dependency rebuild at `http://localhost:5183`: A's committed sliding response was held, A was signed out, B signed in, and A's response was released. The request canceled, B remained current, and a protected Convex identity query succeeded. The test now attaches its cancellation handler immediately and explicitly rejects delivery of A's old body while retaining the original B credential/protected-data assertions. A first run against stale Vite dependency optimization failed and is not final evidence.

The parent and independent reviewer both report the expanded separate-tab A07 scenario passed on the final runtime: a shared browser context holds A's committed response, signs B in through the second tab, then asserts both tabs' private region, current session and positive B backend identity. Thus the final actual-service Chromium A07 script has two passing scenarios. Its first expanded attempt hit a Playwright convenience-context restriction before opening the second tab; changing the harness to an explicit shared browser context corrected the test setup without changing runtime or acceptance assertions. The parent and independent reviewer also report both separate `stale-ui.mjs` scenarios passed for the parent's application callback guards.

A03, real iPhone/Safari/PWA behavior, hosted HTTPS/cross-origin/CSRF arrangements, older-client rollouts, recovery/TOTP, agent grants, file lifecycle and real-data adoption remain separate gates. No service deployment, session policy change, recovery backdoor, production operation or real data migration was performed by this correction task.

## Maintenance and removal

These patches add upstream maintenance cost. Keep versions pinned and require both package source checking and the transport/real-browser regressions on upgrades. Remove the runtime patches only after the corresponding upstream release provides equivalent generation isolation, all-hook cancellation, safe session-atom cancellation and provider promise ordering, and the same acceptance tests pass against the unpatched version. The existing declaration compatibility patches have their own removal conditions in ADR 0002. Do not remove cancellation tests merely because upstream hook order changes.

Package patch files contain verbatim upstream context and removed lines, including upstream trailing whitespace and tab indentation. `.gitattributes` therefore exempts `patches/*.patch` artifact text from whitespace-error classification. Ordinary source whitespace checks remain enabled; this avoids unrelated upstream reformatting solely to satisfy a diff-of-a-diff check.
