# Palladian — independent Astra review, round 14

Date: 2026-10-15  
Commit: **`ce685546eaddeaa8de11b5e17c5e8839ade12827`**

**Core: NOT ACCEPTED — four verified blocking findings.**  
**Edge: ACCEPTED.**

Atomic `finishClear` and deletion during activation fix the original carried-over destructive-cleanup paths. However, retries still lose lifecycle authority, failed revocation can be superseded without cleanup, and receiving notifications can either destroy newer recovery snapshots or miss privacy invalidation. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read round 13, its implementation response, the relevant privacy/session and delivery contracts, and `95f5415..ce68554`. Used the requested detached worktree and frozen install. Backend, edge and notes-core source are unchanged.

- **Repository:** all four package typechecks passed, including Convex. Tests passed: notes-core 28, backend 42, frontend 72 Vitest + 18 Node, edge 64.
- **Independent integration:** 80 preserved/adapted frontend probes, 15 round-14 probes, ten backend probes and three edge probes passed. These use real store/session implementations with fake IndexedDB, real BroadcastChannel, controlled authentication, injected storage failures/interleavings, ProseMirror transforms, mocked Convex identities and edge SQLite/concurrency checks. Passing reproduction assertions confirm the findings below.
- **Actual Chromium:** 40 repository cases, 50 preserved reviewer cases, 18 round-12 cases and 24 round-14 cases passed across desktop and mobile emulation. Two production-build offline cases passed. These exercise React, actual IndexedDB/localStorage, BroadcastChannel, multiple tabs and downloads; authentication and fault timing are controlled. Both accessible and held variants reproduce destructive retries.
- **Probe accounting:** updated probes for the removed `accountBlocked` API and asynchronous two-phase completion. Preserved browser readiness assertions exposed R14-5; final reproduction assertions explicitly record that regression. A failed broadcast read alone was masked by the storage-event fallback; failing the sending revocation hint too reproduces R14-4. All initial logs remain available.
- **Actual local services:** local Convex and Wrangler OAuth/MCP proof passed (31 progress steps). The actual-service Chromium consent proof also passed all eight steps, including live MCP note delivery, disconnect and No access. The default backend binary lacked host GLIBC libraries; the existing deployment's pinned September 28 binary started successfully with `--skip-push`.

No production requests, deployments, mobile WebKit or physical iPhone checks. The implementer's production proof was not independently reverified.

## Still-open findings

| Finding                                                       | Status             | Verification                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work    | **PARTIALLY**      | Hold/access-verification regressions pass; newer held drafts remain vulnerable to R14-1.                                                                                                                  |
| R9-2 — account change erases held work                        | **PARTIALLY**      | Settlement, cancellation and failed-export regressions pass; stale owned retries still bypass settlement under R14-1.                                                                                     |
| R12-1 — stale receiving cleanup erases a later lifecycle      | **PARTIALLY**      | Carried cleanup now preserves durable accessible/held drafts; receiving reads still destroy later memory snapshots (R14-2), and hints sign out fresh sessions (R14-5).                                    |
| R13-1 — blocked read races activation and authorizes deletion | **VERIFIED FIXED** | Delay carried cleanup, activate and write fresh accessible/held work, then resume: atomic `finishClear` preserves it in integration and both Chromium profiles. See the distinct notification race below. |
| R13-2 — stale hint retains destructive authority              | **VERIFIED FIXED** | Failed completion/remember writes leave a stale hint; receiving cleanup preserves fresh durable work in integration and Chromium. Session invalidation remains R14-5.                                     |
| R13-3 — genuine failed cleanup is forgotten                   | **PARTIALLY**      | Original failed-hint/aborted-clear/same-tab-sign-in case now retries and deletes. Another tab's activation still discards genuine required cleanup under R14-3.                                           |

Round-5–13 fence, search, export, dependent-copy, recency, quota-recovery and settlement probes pass within their prior scope. A committed block plus failed deletion stays inaccessible when activation uses an invalid fence; valid activation deletes before unblocking. Delaying phase 2 until after activation also preserves new work. These successful cases do not cover the retries below.

## New findings

### R14-1 — High, BLOCKING: owned retries regain unbounded destructive authority

**Locations:** `apps/notes/src/cache.ts:563–604`; `apps/notes/src/session.ts:272`.

Two independently reproduced paths:

1. Phase 1 commits; phase 2 fails. `unfinishedClears` was already removed. Another tab activates, finishes the recorded deletion, then saves new work. The original page retries its owned cleanup as a fresh clear and deletes that new lifecycle.
2. Phase 1 fails before reading the account. The retry remembers `undefined`, which bypasses the lifecycle comparison. Another tab activates and saves; the retry deletes its work.

Both erase accessible and held drafts and sign out the newer tab without settlement, in integration and both Chromium profiles.

**Fix:** retain an immutable cleanup identity through both phases and retries. Bind it to the lifecycle observed during activation; an unread lifecycle must never become unconditional deletion authority. After a committed block, retries may finish that block, not create a new one against an activated account.

### R14-2 — High, BLOCKING: delayed receiving read destroys newer memory recovery

**Locations:** `apps/notes/src/cache.ts:654–656`, `:646–651`.

Delay a receiving clear after it reads `blocked: true`. Process a subsequent legitimate logout, then sign in and create fresh durable work plus a quota-failed memory-only draft. Resume the old read: `hideAccount` signs out the new session and forgets the new recovery snapshot. Reauthentication retains the durable draft but cannot recover the memory-only text. Verified with store/session integration and both Chromium profiles, using two real clear notifications.

**Fix:** fence the asynchronous receive operation against activation/notification generations and discard stale completions before hiding or forgetting anything. Bind the broadcast to its recorded lifecycle/block generation.

### R14-3 — High, BLOCKING: supersession revives old revoked data without cleanup

**Locations:** `apps/notes/src/cache.ts:577–598`, `:849–854`; `apps/notes/src/session.ts:272–280`.

Persist a draft; receive authoritative device revocation; fail phase 1's account write after the lifecycle was read. Restore storage and sign in through another tab. Its activation sees an unblocked record, retains the old draft and increments `lifecycle`. The original page retries, treats that increment as `SupersededClear`, and drops its required cleanup. Both tabs can export the old revoked draft; no deletion ever succeeded. Verified in integration and Chromium.

**Fix:** make unresolved cleanup durable and generation-bound across tabs, and require activation to finish/quarantine ended-lifecycle data before exposing it. A lifecycle increment is not evidence of successful cleanup. The documented stop-before-block gap is not the only failure: this reproduction keeps the owning page alive.

### R14-4 — High, BLOCKING: failed receiving read loses privacy invalidation

**Locations:** `apps/notes/src/cache.ts:601–603`, `:654–656`.

Fail the revoking tab's hint write and the receiving tab's single account read. The block/deletion succeeds, but `receiveClear` converts the read error to `null` and does nothing. The receiver remains ready with previously opened note content visibly rendered. Repeating the clear cannot repair it: an already-blocked account emits no broadcast. Verified in integration and both Chromium profiles; no later independent auth result was assumed.

**Fix:** retain and retry unresolved invalidations; quarantine display while their authority is unresolved without discarding potentially newer recovery work. One failed read must not acknowledge a privacy notification.

### R14-5 — Medium, NON-BLOCKING: carried cleanup publishes a fresh sign-out hint

**Locations:** `apps/notes/src/session.ts:271–273`; `apps/notes/src/main.tsx:108–113`.

A stale receiving cleanup writes `hideForCleanup` before `finishClear` decides it is obsolete. The storage listener signs out the newly active tab although its drafts survive. Reproduced by the preserved round-12 cases and failed-hint cases in both Chromium profiles.

**Fix:** obsolete carried cleanup must not publish new invalidation intent; apply lifecycle validation to hint-driven session invalidation too.

## Remaining release gates

Resolve R14-1–R14-4 and independently rerun failed-clear, supersession and receiving-tab probes. Retain the legacy-journal transition gap, broader real-service consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates.

Artifacts: `/tmp/palladian-astra-review-r14-ce68554/`. No tracked-file edits, commits, pushes or deployments. `SITE_URL` was restored to `http://localhost:5178` and verified before shutdown. Started services were stopped, the detached worktree was removed without force, and main/notes-core status is clean.
