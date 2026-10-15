# Palladian — independent Astra review, round 7

Date: 2026-10-15  
Commit: **`f518e719b8f249870f72db2a3f7a4578e00819e5`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

Four verified blockers remain: offline-created notes are misclassified, cross-tab memory-only work can be destroyed, a delayed selection exposes fenced content, and existing conflict-copy summaries leak while held. The original recovery overwrite and timestamp-settlement reproductions are fixed. Two additional recovery limitations are non-blocking. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Reviewed the round-6 report, implementation response, specification contracts and source/test diff. Backend, edge and notes-core are unchanged. Applied the Convex reviewer checklist. Installed the requested detached worktree with `pnpm install --frozen-lockfile`.

- **Repository checks:** notes-core 28; backend 42; frontend 46 Vitest plus 14 Node; edge 64. All passed. All four package typechecks passed, including backend Convex and frontend tools/tests, before adding untracked probes.
- **70 independent probes:** 54 preserved/adapted and 16 new. All assertions passed, including assertions reproducing the findings below. Frontend probes use fake IndexedDB, controlled transport and real ProseMirror transforms; backend probes use `convex-test` and mocked identities; edge probes exercise SQLite concurrency and MCP cursor transport. Preserved structural validation exercises 30,000 candidate steps.
- **Actual browsers, synthetic fixtures:** 40 desktop/mobile-emulated Chromium cases, two production-build offline cases, and eight new Chromium probes passed. New probes exercise real IndexedDB and React, including delayed selection, both tabs' copy-close notifications, offline creation and an upgrade using the actual `af38401` cache implementation.
- **Actual local services:** live Chromium proof passed 11 steps; Worker OAuth/MCP proof passed 31; Worker consent-browser proof passed eight, against the existing Convex/Vite/Wrangler services at the reviewed commit.
- **Unavailable/unperformed:** 20 mobile-WebKit cases failed at browser launch because host libraries are missing. No physical iPhone or production checks were performed.

## Prior findings

| Finding                                                    | Status             | Verification                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R5-1 — recovery diffs corrupt concurrent work              | **VERIFIED FIXED** | Adapted formatting, leading-paragraph and paragraph-swap probes preserve collaborator content through copies; isolated recovery reproduces the local document. Content/step-read races cannot overwrite newer revisions. Residual liveness issues are listed separately below.                                                                         |
| R5-2 — pending copies survive revocation                   | **PARTIALLY**      | Stored copies, exports and already-open editors are fenced, including cross-tab feed removal. Delayed selection and pre-existing copy summaries still expose content; memory-only work can be over-purged: R7-2–R7-4.                                                                                                                                  |
| R6-1 — older tab overwrites newer settled recovery         | **VERIFIED FIXED** | Original overwrite probe now leaves the newer server text with one send, even bypassing the lock. Lock contention skips recovery; retry succeeds. Lost-reply/new-typing tests pass with and without the lock API. Opening during client-ID persistence and switching accounts prevent sends. See the separate non-blocking limitations below.          |
| R6-2 — timestamp-only settlement                           | **VERIFIED FIXED** | Different same-time content survives settlement. Same-time changed journal steps prevent replacement, splitting and retirement.                                                                                                                                                                                                                        |
| R6-3 — feed removal leaves open copies visible             | **VERIFIED FIXED** | Expanded revoked IDs reach both stores. Browser probes confirm already-open copies close in the originating and receiving tab.                                                                                                                                                                                                                         |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**      | Original durable-copy scenario now hides and restores the copy after positive verification. Errors/wrong subjects retain holds; unchanged-marker denial purges; repeated snapshots preserve markers; stale denial, later revocation/feed removal and account clear defeat obsolete responses. Another tab's memory-only work is still destroyed: R7-2. |

## New findings

### R7-1 — High, BLOCKING: offline New Note never reaches creation

**Locations:** `apps/notes/src/App.tsx:493`; `apps/notes/src/cache.ts:1015`, `:1031`.

Before live readiness, New Note generates a bare UUID. The new prefix rule excludes it from `localDrafts` and includes it in `adoptedDrafts`, although no server note exists. Browser reproduction creates and saves such a draft; the controller probe makes zero creation calls and retains it indefinitely as allegedly created. This also affects previously stored bare-UUID drafts.

**Fix:** align every creation path with local-ID classification and handle existing uncreated UUID drafts, preserving creation idempotency and the server-ID duplicate-creation protection.

### R7-2 — High, BLOCKING: another tab's quota-failed work is purged without denial

**Locations:** `apps/notes/src/cache.ts:905`, `:925`; revocation receiver `:156`.

Tab B has the only current typing in its recovery map after a quota failure. Tab A shares the cached old-notebook summary but has neither that memory nor a durable draft. Reconciliation in A classifies the note as having no work, deletes it, and broadcasts revocation. B then forgets its recovery map. Restoring access cannot recover the text. The corresponding same-tab quota probe correctly holds and restores it.

**Fix:** do not issue destructive cross-tab revocation from cached notebook provenance before fresh effective-access denial. A local absence of work does not establish its absence in other tabs; preserve their recovery snapshots while checking access.

### R7-3 — High, BLOCKING: a pending selection opens content after hold or revocation

**Locations:** `apps/notes/src/cache.ts:243`–`:250`; `apps/notes/src/App.tsx:183`–`:188`.

Pause selection after `accessibleRecovery` captures the draft, apply a hold or explicit revocation, then resume. `read` obtains the new revoked set but uses the captured recovery result without filtering it. App invalidates the selection request only if the affected note is already shown. With no current editor, the pending selection opens the private text after the fence event, and it remains visible. Both variants reproduce in Chromium; subsequent ordinary reads/exports correctly return nothing.

**Fix:** fence recovered results through the read's completion and cancel affected pending selections, not only already-open editors. Carry a note-access generation through asynchronous open paths.

### R7-4 — High, BLOCKING: existing copies expose titles while held

**Locations:** `apps/notes/src/cache.ts:215`–`:218`, `:1136`–`:1141`.

Round-6 conflict-copy summaries have no `source`; only their drafts carry provenance. Round 7 adds `source` to newly split summaries but does not backfill existing ones. A copy created using the actual previous cache implementation remains listed with its private title after its source is held, although its draft/read/export paths hide it. Verified in unit and browser probes.

**Fix:** migrate existing copy summaries or resolve their source from drafts during filtering. Hide summary title/preview as well as body content.

### R7-5 — Medium, NON-BLOCKING: stale memory stalls recovery and masks newer work

**Locations:** `apps/notes/src/cache.ts:365`–`:366`, `:513`–`:514`.

A saves “Old A”; B durably saves “New B” and closes. Repeated syncs in A read B's durable draft but reject it against A's older memory snapshot. No send occurs, while read/export show “Old A”. The newer durable document remains recoverable, so this probe establishes no deletion.

**Fix:** coordinate draft generations across tabs and distinguish older persisted memory from genuinely newer unsaved memory; do not unconditionally prefer either storage tier.

### R7-6 — Low, NON-BLOCKING: opening during settlement still retires the draft

**Location:** `apps/notes/src/live.ts:661`–`:663`.

Opening the note while `captureFence` awaits bypasses the preceding open-note check; settlement deletes the matching draft while the note is open. The probe reproduces retirement, not content loss.

**Fix:** revalidate open-note ownership at retirement, including waits inside settlement.

## Remaining release gates

Resolve R7-1–R7-4 and independently rerun the preserved probes. Track R7-5/R7-6 and the documented pre-alpha legacy-journal transition gap. Remaining consent-transfer, permission-reduction, account-switching and invitation-failure browser cases, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates remain pending.

Artifacts: `/tmp/palladian-astra-review-r7-f518e71/`. `SITE_URL` was restored and read back as `http://localhost:5178`. No tracked files, commits, pushes, deployments or production data were changed. The detached review worktree was removed; main and notes-core status are clean.
