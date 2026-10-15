# Palladian — independent Astra review, round 17

Date: 2026-10-15  
Reviewed commit: **`61f2552451abc2051506e178aa429a0baf0dc823`**

**Core: ACCEPTED WITH REQUIRED FIXES — no verified blocking findings; R17-1 remains non-blocking.**  
**Edge: ACCEPTED.**

The two round-16 blocking reproductions are fixed. Failed background cleanup no longer becomes successful session activation, and legacy-revoked text no longer reaches the visible editor. Completed operation identities survive activation. A further three-tab case exposes stale recovery state affecting writes and automatic recovery, without reproducing revoked-content display or loss of the current draft. This accepts the scoped core subject to the required fix below, not complete v1 or the outstanding release gates.

## Evidence run

Read round 16, its implementation response, the source/test diff, relevant product/privacy/delivery contracts, and affected store/session/editor/recovery paths. Used the requested detached worktree and frozen install. Only `cache.ts` changed in application source; backend, edge and shared-core source are unchanged.

- **Repository checks:** all four package typechecks passed, including Convex. Tests passed: shared core 28 Node; backend 42 Vitest; frontend 84 Vitest plus 19 Node; edge 64 Vitest.
- **Independent integration:** 116 preserved/adapted frontend probes and 11 new probes passed. Also reran ten preserved backend and three edge probes. Frontend probes use actual store/session/recovery implementations with fake IndexedDB, native Node Web Locks/BroadcastChannel, controlled authentication/service responses and injected storage faults. Backend identities and edge persistence use test substitutes.
- **Actual Chromium:** 40 repository cases, 126 preserved/adapted reviewer cases and 24 new cases passed across desktop and mobile emulation. Two production-build offline cases passed. IndexedDB, localStorage, Web Locks, BroadcastChannel and rendering are real; adversarial authentication, service responses and fault timing are controlled. R16-1 uses the original real-transaction gate; R16-2 and its three-tab extension assert the visible editor.
- **Actual local services:** existing anonymous Convex deployment, pinned September 28 binary with `--skip-push`, and local Wrangler serving a build of the reviewed commit. OAuth/MCP proof passed all 31 steps. Chromium consent proof passed all eight steps, including live note delivery, disconnect and No access.

Additional session probes cover revocation, logout, account-switch cleanup, and an unfinished same-tab clear reaching `allowAccount` through session activation. All remain unready with the account hidden while cleanup fails, and recover after the fault is removed. Queued/held/in-progress close, recorded-block reload, overlapping decisions, delayed failures, retry backoff and completed-operation accumulation/replay regressions pass. No production, mobile WebKit or physical iPhone checks were performed.

Some initial preserved probes encoded superseded behavior: unnamed calls sharing an operation, same-tab activation finishing its own failed clear, and a joined transaction failure permitting readiness. Updated them to explicit retry identities and failure/refusal assertions. An integration recovery check also needed another auth check after successful cleanup invalidated its earlier activation fence. Initial and final logs are preserved; these adaptations are not product findings.

## Previously open findings

| Finding                                            | Status             | Verification                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13-3 — genuine failed cleanup is forgotten        | **VERIFIED FIXED** | Failed-persistence/session retries and transaction-gated background joins retain mandatory cleanup; activation occurs only after successful cleanup in the reproduced running-page paths.                            |
| R14-1 — retries regain destructive authority       | **VERIFIED FIXED** | Known/unknown-lifecycle, overlapping-session and later-held-work regressions pass. Explicit completed IDs replay harmlessly after same-store activation.                                                             |
| R14-3 — supersession revives revoked data          | **VERIFIED FIXED** | Other-tab activation is refused while the failing operation holds its lock; same-tab activation is also refused. Successful cleanup, close/reload with a recorded block and subsequent activation remove old drafts. |
| R16-1 — joined background failure looks completed  | **VERIFIED FIXED** | Original integration and real-IDB Chromium transaction gates now produce cleanup errors, keep the account hidden and never display revoked content. Restoring storage and retrying recovers.                         |
| R16-2 — legacy recovery bypasses draft-read fences | **PARTIALLY**      | Original `readDraft` and visible-editor leak are fixed in integration and both Chromium profiles, including another tab activating first. Other consumers still act on retained ended snapshots: R17-1.              |
| R16-3 — activation forgets completed identities    | **VERIFIED FIXED** | Replaying a finished explicit ID after activation preserves new work; all 40 completed records remain after activation. Unnamed calls now represent separate operations.                                             |

R5–R16 regression coverage also retains the previously verified note fences, search/export filtering, dependent-copy handling, recency, settlement, account-switch cancellation, legacy notifications and close behavior. The documented stop-before-block and database-only fallback qualifications remain; this review does not claim they are eliminated.

## New finding

### R17-1 — Medium, NON-BLOCKING: ended recovery still controls later writes and recovery

**Locations:** `apps/notes/src/cache.ts:1044`, `:405`, `:508`, `:1587`; residual retention at `:1555`.

Create quota-failed memory recovery in tab B. A genuine older-version (`ce68554`) store clears the account and sends its unnumbered notification. Tab A signs in first, lifting the persistent block; B signs in afterward. Because B's activation sees an already-unblocked account, `ended` is false and its old-epoch snapshot survives.

`read`, `readDraft`, list, export and settlement correctly exclude that snapshot. However:

- `writeDraft` copies sticky fields from it without validating its epoch. The probe persisted the old notebook/client/created/source fields into a current write.
- When A writes a current draft for the same server note, B's `replaceDraftIf` and `splitConflict` reject it because their raw memory lookup sees a different old snapshot.
- Through the actual `LiveController`, three successive sync attempts neither send the current draft nor split its conflict. A fresh store immediately reaches the send or produces the conflict copy. Successful `settleDraft` also leaves a differing ended snapshot retained, although it remains unreadable.

Verified with integration and both Chromium profiles. A separate visible-editor check shows current server content, not the revoked base. The current draft remains readable/exportable, and reload restores recovery; no current-content loss or unauthorized text exposure was demonstrated. Therefore this is **non-blocking**, rather than a recurrence of the round-16 privacy blocker.

**Required fix:** discard or ignore recovery snapshots whose captured account epoch differs from the activated/current epoch, even when another tab already lifted the block. Apply that rule to sticky-field merging and compare-and-replace/split guards, while preserving genuine same-epoch recovery. Add the three-tab activation-order and recovery-controller regressions.

## Remaining release gates

Resolve R17-1 and rerun its three-tab consumers. Retain the documented stop-before-block gap, database-only fallback qualification, legacy-journal transition, broader actual-service account-switch/consent-transfer/permission-reduction/invitation-failure coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates. The reported host limitation for mobile WebKit was not rechecked this round.

Artifacts and reproducible probes: `/tmp/palladian-astra-review-r17-61f2552/`. No tracked-file edits, commits, pushes or deployments. Local `SITE_URL` was restored and compared byte-for-byte; started services were stopped and their ports checked closed. The detached review worktree was removed. Main and notes-core status are clean.
