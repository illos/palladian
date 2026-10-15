# Palladian — independent Astra review, round 15

Date: 2026-10-15  
Reviewed commit: **`905cef48b65a5211478bb287420dadfb7d6b44f5`**

**Core: NOT ACCEPTED — three verified blocking findings.**  
**Edge: ACCEPTED.**

The Web Lock redesign fixes the original round-14 interleavings when the clearing tab knows its lifecycle and operations do not overlap within that tab. It still permits destructive retries with missing or mutable lifecycle authority. Legacy notifications also discard newer recovery. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read round 14, its implementation response, the relevant product/privacy/delivery contracts, and the complete source/test diff. Used the requested detached worktree and frozen install. Backend, edge and shared-core source are unchanged.

- **Repository checks:** all four package typechecks passed, including Convex. Tests passed: notes-core 28; backend 42; frontend 77 Vitest + 19 Node; edge 64.
- **Independent integration:** 80 preserved frontend probes, 17 adapted/new round-14/session and overlap probes, 11 additional lifecycle/lock probes, ten backend probes and three edge probes passed. These use actual store/session implementations with fake IndexedDB, native Node Web Locks/BroadcastChannel, controlled authentication, injected storage failures and interleavings; backend identities and edge persistence are test substitutes. Reproduction assertions intentionally confirm defects.
- **Actual Chromium:** 40 repository cases, 50 preserved reviewer cases, 18 round-12 cases, and 34 adapted/new round-14/15 cases passed across desktop and mobile emulation. Two production-build offline cases passed. React, IndexedDB, localStorage, locks, BroadcastChannel and multiple tabs are real; authentication and fault timing are controlled.
- **Collaborative Chromium:** eleven distinct store probes exercised lock ownership, retries, lifecycle loading and legacy messages; an additional two-tab probe verified automatic lock release on actual tab closure. Shared holders coexist; exclusive clears wait; `ifAvailable` refuses when an exclusive request is queued. Two clearing stores complete without deadlock. Persistent injected failures refuse sign-in; recovery succeeds after storage restoration. Ordinary `close()` releases an already-held lock, but queued acquisition fails shutdown safety below.
- **Actual local services:** pinned September 28 Convex binary with `--skip-push`, plus Wrangler: OAuth/MCP proof passed all 31 steps. Actual-service Chromium consent proof passed all eight steps, including live note delivery, disconnect and No access.

Initial typechecks included untracked reviewer probes and failed on probe typing; clean-source reruns passed. Four initial browser reproductions stalled in the authentication fixture; selecting its revoked mode corrected the setup, and all four passed. A transaction-gated fake-IDB probe did not reach the overlap; ungated integration and transaction-gated Chromium probes reproduced it. Initial logs are preserved. No production checks, mobile WebKit or physical iPhone checks were performed.

## Previously open findings

| Finding                                                    | Status             | Verification                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**      | Existing hold/access tests pass; newer held drafts are still erased by R15-1.                                                                                                                             |
| R9-2 — account change erases held work                     | **PARTIALLY**      | Settlement, cancellation and export regressions pass; R15-1/2 bypass settlement.                                                                                                                          |
| R12-1 — receiving cleanup erases a later lifecycle         | **PARTIALLY**      | Atomic carried cleanup and numbered notifications preserve newer work; legacy notification handling loses memory recovery under R15-3.                                                                    |
| R13-3 — genuine failed cleanup is forgotten                | **VERIFIED FIXED** | Unread block, failed block write and failed deletion retain the lock; another tab cannot activate until cleanup completes. Original same-tab failed-hint case passes. Documented owner-close gap remains. |
| R14-1 — owned retries regain destructive authority         | **PARTIALLY**      | Original known-lifecycle paths 1/2 now refuse competing activation in integration and Chromium; R15-1/2 reproduce remaining authority failures.                                                           |
| R14-2 — delayed receiving read destroys newer recovery     | **VERIFIED FIXED** | Delay a real numbered notification across another logout/sign-in; newer durable and quota-failed memory drafts survive. Receiving no longer reads the account.                                            |
| R14-3 — supersession revives revoked data                  | **VERIFIED FIXED** | Keep the revoking page alive through each storage failure: competing activation is refused; restoration/retry deletes old data before activation.                                                         |
| R14-4 — failed receiving read loses invalidation           | **VERIFIED FIXED** | Fail receiving account reads and sender hint writes together: committed clear still signs out the receiver and removes its open editor.                                                                   |
| R14-5 — carried cleanup publishes fresh sign-out           | **VERIFIED FIXED** | Delayed carried cleanup and failed-hint regressions preserve both the newer session and accessible/held drafts.                                                                                           |

R13-1/R13-2 remain fixed. Round-5–13 fence, search, export, dependent-copy, recency, recovery and settlement regressions pass within their existing scope.

## New findings

### R15-1 — High, BLOCKING: unknown lifecycle remains unrestricted after successful cleanup

**Locations:** `apps/notes/src/cache.ts:178`, `:588`, `:600`, `:750`; `apps/notes/src/session.ts:272`.

Open tab A before the account record exists; tab B signs in and creates data. A receives authoritative revocation, its block write fails, then its background retry succeeds. B signs in again and creates a fresh accessible or held draft. A's subsequent session retry repeats its still-owned cleanup. A never learned a lifecycle, so `meant === undefined` bypasses the comparison and deletes B's new draft without settlement.

Verified through session integration and both Chromium profiles, with the original page kept alive throughout. No startup read failure is required.

**Fix:** bind every clear to an immutable resolved lifecycle/operation identity, including initially unknown accounts; retain completion so session retries cannot restart a completed operation with unrestricted authority.

### R15-2 — High, BLOCKING: overlapping same-tab clears retarget a later lifecycle

**Locations:** `apps/notes/src/cache.ts:588–590`, `:627`, `:630`, `:704`, `:750`, `:968`.

After failed revocation, overlap its background clear with a session retry. Both reuse the held lock and queue real transactions. The first deletion fails and schedules a retry; the second succeeds and releases the lock without cancelling that newly scheduled retry. Sign in and create new work. The leftover retry reads the updated lifecycle map and deletes the new work without settlement.

Verified through session integration and both Chromium profiles, then strengthened with real Chromium transaction ordering and ungated overlapping store calls in integration. Only storage failure and scheduling are controlled; lifecycle, lock and session decisions are unchanged.

**Fix:** coalesce/serialize clears per account, retain the original operation identity across attempts, and release ownership only when all work for that operation has settled. An obsolete completion must neither schedule another clear nor release another operation's lock.

### R15-3 — High, BLOCKING: legacy notification destroys newer memory recovery

**Location:** `apps/notes/src/cache.ts:691–695`.

Delay a genuine unnumbered clear notification from the `ce68554` store. Activate a new lifecycle in the current store and create quota-failed, memory-only typing. Deliver the old notification: unconditional `hideAccount` forgets that recovery. Signing in again cannot restore it. Verified with previous-version source in integration and actual Chromium, plus a direct legacy-message probe.

**Fix:** quarantine legacy invalidations without destroying recovery whose lifecycle is unresolved; validate against current durable/block authority and fence asynchronous validation against newer activation. Alternatively enforce an explicit safe version-transition protocol before accepting unnumbered destructive messages.

### R15-4 — Medium, NON-BLOCKING: queued acquisition survives `close()` and leaks ownership

**Locations:** `apps/notes/src/cache.ts:701–716`, `:1608–1614`.

A holds the lock after failure; B queues a clear, then closes. When A releases, B still acquires, hits `DatabaseClosedError`, and schedules retries while retaining the lock. Other stores are refused sign-in until B is closed again or its page exits. Verified in integration and Chromium. No production caller of `NotesStore.close()` was found, so this is currently an API/shutdown defect.

**Fix:** cancel pending lock requests on close, latch closed state, and prevent late acquisition/failure callbacks from retaining locks or scheduling retries.

## Remaining release gates

Resolve R15-1–R15-3 and independently rerun these interleavings. Retain the documented stop-before-block gap, database-only fallback qualification, legacy-journal transition, broader actual-service account-switch/consent-transfer/permission-reduction/invitation-failure coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates.

Artifacts and report: `/tmp/palladian-astra-review-r15-905cef4/`. No tracked-file modifications, commits, pushes or deployments. `SITE_URL` was restored to `http://localhost:5178` and compared with its original value. Started services and browser tabs were stopped; the detached worktree was removed without force; main and notes-core status are clean.

Execution incident: a process-list inspection inadvertently printed a local backend instance secret. Its value is omitted from this report; no production credential was selected.
