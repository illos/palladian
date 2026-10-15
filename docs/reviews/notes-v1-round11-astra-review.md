# Palladian — independent Astra review, round 11

Date: 2026-10-15  
Commit: **`fa45670e5ad5fef5089cc200c0f0ded15e5d1621`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

The original round-10 reproductions pass with corrected expectations. Four additional blocking cases remain, verified below. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read the round-10 report, implementation response, product contracts and `45b2fe4..fa45670` source/test diff. Backend, edge and notes-core are unchanged. Installed the detached review worktree with the frozen lockfile; no tracked files were modified.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 70 Vitest plus 16 Node; edge 64. All passed. All four package typechecks passed, including backend Convex, before adding untracked reviewer probes.
- **106 independent unit/integration probes:** 84 preserved/adapted frontend, nine new frontend, ten backend and three edge. Final assertions passed, including assertions reproducing defects. These use fake IndexedDB, controlled session/transport results, real ProseMirror transforms, backend `convex-test` with mocked identities, edge SQLite/concurrency checks, and real BroadcastChannel delivery.
- **Actual Chromium:** 40 repository desktop/mobile-emulated cases, 34 reviewer desktop cases, six new reviewer mobile-emulated cases, and two production-build offline cases passed. Reviewer probes exercise actual React, IndexedDB, BroadcastChannel, downloads and multiple tabs, with controlled authentication results, quota failures and race timing. New persistence races pause before write transactions, not inside active IndexedDB transactions.
- **Probe corrections:** one preserved browser case initially selected the source row before the conflict-copy list refresh; it now waits for the replacement source title before selecting the copy. An initial new probe incorrectly expected the UI to refresh after reload; its final assertion checks the reopened store directly. Initial logs are retained. Neither failed assertion is presented as an additional finding.
- **Not run:** actual Convex/Worker authentication, OAuth/MCP or consent-browser proofs; mobile WebKit; physical iPhone; production checks. Only local Playwright-managed Vite/preview servers were started. Prior live-service results remain historical evidence; `SITE_URL` was not changed.

## Prior findings

| Finding                                                    | Status             | Verification                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**      | Preserved hold, positive-verification, denial and stale-verdict probes pass. R11-3 still strands retained recovery during account transitions.                                                                                            |
| R8-1 — sign-out destroys held work                         | **PARTIALLY**      | Held-work dialogs, Cancel and ordinary export confirmation pass in Chromium. R11-4 still clears held memory-only work without coverage.                                                                                                   |
| R9-1 — later hold invalidates logout recovery              | **PARTIALLY**      | Original hold-start/end cases and changed-document fingerprints pass; a replacement snapshot during confirmation escapes accounting in R11-4.                                                                                             |
| R9-2 — account change erases held work                     | **PARTIALLY**      | Ordinary switching, failed retirement, repeated retirement, A→B→C, failed activation, account isolation and pending-logout cancellation pass. R11-1–R11-3 remain.                                                                         |
| R9-3 — captured memory overrides newer durable drafts      | **VERIFIED FIXED** | Preserved read/list/export races, actual Chromium selection/edit reproduction, stored-recency comparison and newer typing during restoration pass.                                                                                        |
| R10-1 — receiving tabs turn retirement into clearing       | **VERIFIED FIXED** | Adapted session/store and two-page Chromium probes preserve the retired draft through the receiving tab's A→A return. Events retain `retired`; no destructive cleanup is adopted. Separate activation defect: R11-1.                      |
| R10-2 — retirement drops its only snapshot                 | **PARTIALLY**      | Failed retirement transaction, persistent quota/retry and distinct same-time documents now survive. Restoration overlapping another retirement strands the snapshot: R11-3.                                                               |
| R10-3 — delayed retirement saves undo clearing             | **PARTIALLY**      | Original delayed-save/clear and Chromium device-revocation reproductions pass; both delayed clear/retirement broadcast orders leave cleared storage empty. Later activation or retirement makes old captured saves eligible again: R11-2. |
| R10-4 — confirmation combines inconsistent reads           | **PARTIALLY**      | One settlement read blocks the original hold-start race in Chromium. Replacement memory is still omitted from that read in R11-4.                                                                                                         |
| R10-5 — list ignores stored recency                        | **VERIFIED FIXED** | Independent two-store probe now returns the newer durable title, consistent with read, readDraft and export.                                                                                                                              |

## New findings

### R11-1 — High, BLOCKING: an already-connected receiving tab stays blocked

**Locations:** `apps/notes/src/main.tsx:74`, `:100`.

Both tabs have activated A. Tab 1 switches A→B; Tab 2 adopts retirement and subsequently authenticates as A. Its `activated` variable still equals A because receiving invalidation does not reset it. `onAccountReady` returns without `allowAccount`.

Desktop and mobile-emulated Chromium show Tab 2 reporting **Connected**, with A's retained draft still durable, but an empty library and rejected writes. Reload permits the store to activate again. The original probe started with stalled authentication and therefore missed this branch.

**Fix:** invalidate the activation memo when receiving account invalidation/retirement, or bind the shortcut to the current cache activation generation. Refresh consumers after successful activation.

### R11-2 — High, BLOCKING: old preservation survives a clear into a later lifecycle

**Locations:** `apps/notes/src/cache.ts:827`, `:835`, `:852`, `:861`.

Two independently reproduced sequences:

1. Restoration captures retired snapshots; pause before its write transaction. Clear A and freshly activate A. Resume restoration: it recreates the erased draft because it checks only `blocked`.
2. A retirement save captures snapshots; pause before its write transaction. Clear A, activate A, then retire A again. Resume the old save: the new record is again blocked/retired, so erased content returns.

Fake-IDB and real Chromium reproduce both. The flag is replaced correctly by clearing, but the boolean checks cannot distinguish different lifecycles.

**Fix:** bind each retained batch and both preservation paths to durable account/cleanup generations. Validate those generations inside the transaction, and prevent stale catch/retry paths from assigning cleared snapshots fresh authority.

### R11-3 — High, BLOCKING: overlapping retirement strands the sole recovery copy

**Location:** `apps/notes/src/cache.ts:854–872`.

Keep a quota-only draft, retire A, then begin restoring it. After restoration removes the retired batch but before its write transaction, retire A again. Restoration rejects the blocked record and installs the snapshot into `recoveryDrafts` with a rejected `captureFence` promise. The next activation has no retired batch to restore; recovery readers permanently skip that fence.

Fake-IDB and desktop/mobile Chromium show the subsequent export empty while the sole snapshot remains stranded in memory. This is unavailable work, not proven immediate byte deletion; closing the tab loses it.

**Fix:** keep restoration batches owned by their lifecycle until committed. A concurrent retirement must retain them in retired recovery; install active recovery only with a successfully validated current fence.

### R11-4 — High, BLOCKING: settlement omits replacement memory and approves an empty export

**Locations:** `apps/notes/src/cache.ts:621`, `:637–645`; `apps/notes/src/logout.ts:138–148`.

Export a held quota-only draft: the file is empty. Lift the hold. During confirmation, after recovery snapshots are captured, inject a replacement quota-failed snapshot and another hold. `isCurrent` rejects the old captured object; the replacement is absent from the captured array and durable storage. Settlement reports zero drafts/held work, matching the empty export.

The controlled Chromium interleaving observes `{total: 1, held: 1}` through a fresh read during confirmation, then the actual dialog completes logout and clears every copy. A separate unit probe demonstrates the missing replacement independently. This occurs during settlement, not merely after a completed validation.

**Fix:** version memory recovery together with settlement; retry or reject when it changes during the read. Never interpret an invalidated captured snapshot as proof that its replacement does not exist. Carry validated settlement identity through cleanup.

## Remaining release gates

Resolve R11-1–R11-4 and independently rerun their probes before core acceptance. Keep the legacy-journal transition gap, remaining consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r11-fa45670/`. The detached review worktree was removed; main and notes-core status are clean. All started servers stopped. No commits, pushes, deployments, production requests or tracked-file changes were made.
