# Palladian — independent Astra review, round 10

Date: 2026-10-15  
Commit: **`45b2fe4cecc6c31a8189b37a503bf4b335e5334c`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

The original round-9 reproductions pass with corrected expectations. Four additional blocking cases remain: cross-tab retirement becomes destructive cleanup, failed retirement loses memory-only work, delayed retirement saves undo account clearing, and logout confirmation combines inconsistent recovery snapshots. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Reviewed the round-9 report, implementation response and `a4e2120..45b2fe4` source/test diff. Confirmed backend, edge and notes-core are unchanged. Installed the requested detached worktree with the frozen lockfile. No tracked files were modified.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 63 Vitest plus 15 Node; edge 64. All passed. All four package typechecks passed, including backend Convex and frontend tools/tests, before installing untracked reviewer probes.
- **97 independent unit/integration probes:** 88 preserved/adapted plus nine new. All final assertions passed, including assertions reproducing defects. These use fake IndexedDB, controlled session/transport results, real ProseMirror transforms, backend `convex-test` with mocked identities, edge SQLite/concurrency checks, and real BroadcastChannel delivery. Coverage includes retirement failure/retry, account isolation, late writes, same-time documents, two genuinely unsaved concurrent snapshots, `readDraft` timing, and retirement/clear ordering.
- **Actual Chromium:** 40 repository desktop/mobile-emulated cases, 22 preserved/adapted reviewer cases, six new reviewer cases, and two production-build offline cases passed. Reviewer probes use actual React, IndexedDB, BroadcastChannel, downloads and multiple tabs; authentication results and race timing are controlled. The six new cases include four defect reproductions.
- **Harness corrections:** two preserved tests used timestamp `9` after a wall-clock-dated draft; changed it to `copy.updatedAt + 1` to preserve their intended newer-write scenario. The initial hold-ending browser probe called only `allowNotes`; corrected it to include the following `cacheSummaries` notification used by the real access-verification flow. These were probe issues, not additional application findings.
- **Not rerun:** actual Convex/Worker authentication, OAuth/MCP and consent-browser proofs; mobile WebKit; physical iPhone; production checks. Only local Vite/preview servers were started. Prior live-service evidence remains historical; `SITE_URL` was not changed.

## Prior findings

| Finding                                                    | Status        | Verification                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY** | Preserved hold/positive-verification, denial and stale-verdict probes pass. Retirement still destroys retained work in R10-1/R10-2.                                                                                                                  |
| R8-1 — sign-out destroys held work                         | **PARTIALLY** | Initial-held and later-held dialogs, Cancel and ordinary confirmation checks pass in Chromium. R10-4 still permits implicit destruction through export confirmation.                                                                                 |
| R9-1 — later hold invalidates logout recovery              | **PARTIALLY** | Original empty-export reproduction is blocked; warnings update through real store-event sequences, and same-time document changes require another export. A hold changing between the two confirmation reads still bypasses settlement: R10-4.       |
| R9-2 — account change erases held work                     | **PARTIALLY** | Original single-tab switch now preserves the held draft. Pending-retirement/reload tests pass; B's list/read/export/notebooks remain empty, and old cache writes are rejected. Cross-tab cleanup, quota loss and unfenced saves remain: R10-1–R10-3. |
| R9-3 — captured, retired memory overrides newer drafts     | **PARTIALLY** | Original three unit races and Chromium selection/edit reproduction now return newer durable text. `readDraft` handles replacement memory and recency ties. The claimed recency protection is missing from `list`: R10-5.                             |

Preserved search fencing, old-version copy provenance, delayed revocation and in-flight export probes also pass.

## New findings

### R10-1 — High, BLOCKING: another tab converts retirement into deletion

**Locations:** `apps/notes/src/cache.ts:198`, `apps/notes/src/main.tsx:101`, `apps/notes/src/session.ts:114`.

Tab 1 switches A→B. Tab 2 receives `{accountId: A, retired: true}`, but the store emits the same `invalidated` event used for logout. `adoptInvalidation` sets `pendingCleanup = A`. On Tab 2's next explicit sign-in—even back to A—the session clears A's retained drafts without settlement.

Independent session/store and actual two-page Chromium probes verify the held draft survives retirement, then disappears on the receiving tab's sign-in with no recovery dialog.

**Fix:** preserve the retirement reason through cache events and session adoption. Receiving sessions must retain pending-retirement semantics; only explicit logout/device revocation may establish destructive cleanup.

### R10-2 — High, BLOCKING: retirement drops the only snapshot before preservation succeeds

**Locations:** `apps/notes/src/cache.ts:196`, `:736`, `:810`, `:826`.

Both retirement paths remove recovery entries before attempting durable preservation. If the retirement transaction fails, or snapshot writes still fail with quota, the sole in-memory draft is already gone. Restoring storage and signing back into A in the same still-open tab returns no draft. The catch comment suggesting snapshots survive until the tab closes is incorrect.

Independent probes cover transaction failure/retry and persistent quota; Chromium confirms immediate quota loss. A separate probe finds that a distinct newer memory document sharing the stored draft's timestamp is silently skipped by `stored.updatedAt >= draft.updatedAt`, leaving only the older document.

**Fix:** retain isolated recovery entries until durable preservation succeeds or an explicit authorized discard occurs. Retry failures; compare snapshot identity/content when timestamps tie and retain conflicting work rather than silently dropping it.

### R10-3 — High, BLOCKING: delayed retirement saves undo completed account clearing

**Locations:** `apps/notes/src/cache.ts:199`, `:791`, `:796`.

A receiving tab's `saveSnapshots` has no account epoch/retirement fence. Pause it before its transaction, complete account clearing, then resume: it recreates drafts and summaries. `clearAccount` also removes note fences, so checking those alone cannot prevent resurrection.

Independent probes reproduce this ordering. In two-page Chromium, an injected authoritative device-revocation result completes cleanup; the delayed retirement save then restores the document, and a subsequent sign-in displays it again.

**Fix:** bind preservation to a durable retirement generation and verify that generation inside the write transaction with the account record. Logout/revocation must invalidate all outstanding preservation attempts, including delayed broadcasts.

### R10-4 — High, BLOCKING: export confirmation combines incompatible snapshots

**Location:** `apps/notes/src/logout.ts:136`.

Export while a draft is held: the file is empty. Access is confirmed while the dialog remains open. During confirmation, `unsavedWork` reads `{total: 1, held: 0}`; another hold commits before `exportDrafts`, which returns `[]`. The fingerprint matches the earlier empty file, so confirmation signs out and deletes the held draft.

Chromium reproduces this with pauses outside IndexedDB transactions. The hold occurs **during** the confirmation checks, not merely in the acknowledged gap after checking and before clearing.

**Fix:** obtain export coverage and held-work state from one coherent snapshot; reject inconsistent coverage. Carry a validated settlement generation into cleanup so intervening writes/access changes require revalidation.

### R10-5 — Medium, NON-BLOCKING: list ignores durable draft recency

**Location:** `apps/notes/src/cache.ts:298`.

`list` calls `isCurrent(draft, undefined)`, bypassing its timestamp comparison. Tab A retains an older quota-only snapshot; Tab B stores newer text. A's list still shows the older title/preview while its `read`, `readDraft` and export correctly return the newer document. An independent two-store probe verifies the discrepancy; no additional body overwrite was demonstrated here.

**Fix:** compare memory overlays against the corresponding durable draft/version read in the fenced transaction.

## Remaining release gates

Resolve R10-1–R10-4 and independently rerun these probes before core acceptance. Keep the legacy-journal transition gap, remaining consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r10-45b2fe4/`. The detached review worktree was removed; main and notes-core status are clean. All started servers stopped. No commits, pushes, deployments, production requests or tracked-file changes were made.
