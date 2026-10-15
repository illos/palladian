# Palladian — independent Astra review, round 8

Date: 2026-10-15  
Commit: **`8c1463b696361816a5dfb7d73dc7d9717f121bff`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

The original round-7 reproductions pass after adaptation, but five verified blocking scenarios remain. R7-4 is only partially fixed across mixed-version tabs. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Reviewed the round-7 report, implementation response, specification contracts and source/test diff. Backend, edge and notes-core are unchanged. Applied the Convex review checklist. Installed the requested detached worktree with the frozen lockfile.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 53 Vitest plus 14 Node; edge 64. All passed. All four package typechecks passed before installing untracked probes, including backend Convex and frontend tools/tests.
- **77 independent unit/integration probes:** 70 preserved/adapted plus seven new; all assertions passed, including assertions reproducing defects. Frontend uses fake IndexedDB, controlled transport and real ProseMirror transforms; backend uses `convex-test` with mocked identities; edge probes cover SQLite concurrency and MCP cursors. Structural validation exercises 30,000 candidate steps. Pending and later quota-failed snapshots survive earlier successful writes and server-ID adoption.
- **Actual Chromium, synthetic fixtures:** 40 desktop/mobile-emulated repository cases, two production-build offline cases, eight adapted round-7 probes and eight new probes passed. New cases exercise actual React, IndexedDB, downloads and old-cache migration; search transport is mocked.
- **Actual local services:** live Chromium proof passed all 11 steps; Worker OAuth/MCP proof passed 31; Worker consent-browser proof passed eight against existing services at the reviewed commit.
- **Unavailable/unperformed:** all 20 mobile-WebKit cases failed at launch because host libraries are missing. No physical iPhone or production checks. No verified cause was established for the reported production crash; these successful local runs do not explain it.

## Prior findings

| Finding                                                    | Status             | Verification                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R5-2 — pending copies survive revocation                   | **PARTIALLY**      | Stored copies and ordinary reads/exports are fenced; both tabs close open copies. In-flight exports and mixed-version summaries still expose content: R8-3/R8-5.                                                                                                   |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**      | Durable and quota-only work survives reconciliation and positive verification. Errors/wrong subjects retain holds; stale verdicts cannot defeat later revocation, feed removal or account clearing. Sign-out and delayed broadcasts still discard work: R8-1/R8-4. |
| R7-1 — offline New Note never created                      | **VERIFIED FIXED** | Chromium produces `local-` drafts; controller probes create both prefixed IDs and legacy UUIDs, never server-ID drafts. Installed Convex ID documentation specifies base-32 encoding, disjoint from dashed UUIDs.                                                  |
| R7-2 — reconciliation purges another tab's memory          | **VERIFIED FIXED** | Original two-store quota reproduction now holds without destructive notification; positive verification restores exportable typing. Separate stale-broadcast defect below.                                                                                         |
| R7-3 — pending selection reopens fenced text               | **VERIFIED FIXED** | Both original delayed Chromium selections remain closed after hold/revocation; delayed cache reads return nothing.                                                                                                                                                 |
| R7-4 — existing copy summaries leak                        | **PARTIALLY**      | Actual previous-cache database upgrades and hides existing copies. An older open tab can subsequently recreate a summary without provenance: R8-5.                                                                                                                 |
| R7-5 — stale memory masks newer durable work               | **VERIFIED FIXED** | A reads and synchronizes B's later durable save. Additional queued/failing-write and adoption probes retain unsaved snapshots.                                                                                                                                     |
| R7-6 — opening during settlement                           | **VERIFIED FIXED** | Original capture-fence interleaving retains the open draft. Server-ID classification prevents subsequent recovery from creating a duplicate.                                                                                                                       |

## New findings

### R8-1 — High, BLOCKING: sign-out silently destroys held work

**Locations:** `apps/notes/src/cache.ts:501`; `apps/notes/src/main.tsx:78`, `:87`.

`hasDrafts` excludes held work. With an unsent draft held pending verification, voluntary Sign out skips the recovery dialog and `clearAccount` deletes it. Chromium verifies a stored draft and held marker before clicking, no dialog, then zero drafts. No denial or explicit discard occurred. “Wait for save” uses the same predicate and can likewise treat held work as settled.

**Fix:** distinguish retained unsaved work from currently exportable work. Require resolution, cancellation or explicit discard for held drafts; do not permit export until access is confirmed.

### R8-2 — High, BLOCKING: server-search results ignore note fences

**Locations:** `apps/notes/src/App.tsx:267`, `:612`.

Search results are guarded only by account/session generation. After a hold or revocation, the library drops the note but its cached search title/excerpt stays visible; a search response arriving afterward also installs it. Four Chromium cases reproduce both timings and both fence types while `store.list` is empty.

**Fix:** invalidate/filter existing hits on note-access events and fence pending search responses by note-access generation. Revalidate before displaying or opening results.

### R8-3 — High, BLOCKING: in-flight exports bypass newer fences

**Locations:** `apps/notes/src/cache.ts:523`–`:534`; analogous list assembly at `:223`–`:243`.

Pause `accessibleRecovery` after the initial draft/fence reads, hold or revoke the note, then resume. `exportDrafts` returns previously collected private work because its final checks cover only the account epoch. Chromium reproduces actual JSON downloads containing the fenced text through the normal sign-out Export drafts button. Independent probes also reproduce stale `list` results; no separate library-render leak is claimed.

**Fix:** validate the complete assembled result against current note fences at completion, and invalidate exports/downloads when note-access generation changes. Apply the same rule to summary reads.

### R8-4 — High, BLOCKING: stale revocation broadcast erases newer work

**Location:** `apps/notes/src/cache.ts:152`–`:166`.

Delay delivery of A's revocation message to B. Lift that marker after renewed authorization, then have B write new quota-failed work. Delivering the old message unconditionally calls `forgetNotes`, deleting the only snapshot of the newly authorized typing. The probe uses real BroadcastChannel with controlled delivery; exports contain the new work before delivery and are empty afterward.

**Fix:** carry revocation/account generations in notifications and associate recovery snapshots with their access generation. Delete only work covered by that decision; obsolete broadcasts must not affect newer authorization.

### R8-5 — High, BLOCKING: old tab recreates provenance-free copies after upgrade

**Locations:** `apps/notes/src/cache.ts:123`–`:129`, `:223`–`:227`.

In Chromium, keep an actual `af38401` cache connection open, open version 4, then create a conflict copy through the old instance. Dexie closes the connection for upgrade but subsequently reopens it successfully. The old writer creates a summary without `source` after the one-time backfill. Holding its source hides the body but leaves the private title in `list`. Upgrade itself did not block or fail in this probe.

**Fix:** make current readers resolve missing provenance from drafts, or safely prevent incompatible old writers from continuing while preserving their unsaved work. Migration alone cannot establish this invariant.

## Remaining release gates

Resolve R8-1–R8-5 and independently rerun the preserved probes. Keep the documented pre-alpha legacy-journal transition gap, remaining consent-transfer/permission-reduction/account-switch/invitation-failure browser cases, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r8-8c1463b/`, including probes, commands and logs. `SITE_URL` was restored and read back as `http://localhost:5178`. No tracked files, commits, pushes, deployments or production data were changed. The detached review worktree was removed; main and notes-core status are clean.
