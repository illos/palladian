# Palladian — independent Astra review, round 9

Date: 2026-10-15  
Commit: **`a4e21207f13ab8d4c236d188295a83e471654d39`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

The original round-8 reproductions now pass with their expected outcomes reversed. Three additional blocking scenarios remain: changing holds can invalidate logout recovery, account changes bypass settlement, and captured memory can mask newer durable work. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Reviewed the round-8 report, implementation response, applicable specification contracts and `8c1463b..a4e2120` diff. Backend, edge and notes-core are unchanged. Installed the requested detached worktree using the frozen lockfile; no tracked files were edited.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 59 Vitest plus 14 Node; edge 64. All passed. All four package typechecks passed, including backend Convex and frontend tools/tests, before adding untracked reviewer probes.
- **88 independent unit/integration probes:** 77 preserved/adapted plus 11 new; all assertions passed, including assertions reproducing defects. These use fake IndexedDB, controlled session/transport responses, real ProseMirror transforms, backend `convex-test` with mocked identities, and edge SQLite/concurrency probes. The original stale-revocation probe uses real BroadcastChannel with delayed delivery. Additional cases cover hold→revoke, revoke→hold, account clearing and database closure. Expiry retains held work; authoritative device revocation clears it as specified.
- **Actual Chromium:** 40 repository desktop/mobile-emulated cases, 16 preserved/adapted reviewer cases, six new reviewer cases and two production-build offline cases passed. Reviewer cases use actual React/IndexedDB/downloads with synthetic data and controlled search/session responses. All seven fenced readers were exercised repeatedly in Chromium. Source inspection found only IndexedDB awaits inside `fenced`; no TransactionInactiveError occurred. Pauses were moved to the memory phase, outside transactions.
- **Actual local services:** existing local Convex, Vite and Worker services passed the live Chromium proof (11 steps), Worker OAuth/MCP proof (31), and consent-browser proof (8).
- **Unavailable/unperformed:** one mobile-WebKit case was attempted and failed at browser launch because host libraries are missing. No physical iPhone or production checks.

Inspected selection/openRemote, channel initialization, search opening, notebook views, revision lookup, fixtures and export assembly. `bodyRevision` is a background fetch optimization, not a content-display path. No additional verified fence bypass was found in those paths; the stale-memory display defect is detailed below.

## Prior findings

| Finding                                                    | Status             | Verification                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-2 — pending copies survive revocation                   | **VERIFIED FIXED** | Preserved source/copy, quota, stale-write and cross-tab editor probes pass. Paused lists/exports now omit fenced content; mixed-version copy titles are hidden.                                                |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**      | Holds preserve durable/quota-only work; positive verification restores it, while stale/wrong-subject verdicts cannot lift newer fences. Recovery still loses held work through R9-1/R9-2.                      |
| R7-4 — existing copy summaries leak                        | **VERIFIED FIXED** | Chromium upgrades an actual old cache and hides copies, including copies written by the older connection after upgrade.                                                                                        |
| R8-1 — sign-out destroys held work                         | **PARTIALLY**      | Held work present at dialog creation now triggers the dialog and warning; Cancel retains it and offline Wait does not complete. A later hold bypasses that warning and settlement: R9-1.                       |
| R8-2 — search ignores fences                               | **VERIFIED FIXED** | Four original Chromium timings cover displayed/delayed results under hold/revocation. Two additional cases pause `fencedNotes`; an intervening access event causes another filter pass and no excerpt appears. |
| R8-3 — in-flight exports/lists bypass fences               | **VERIFIED FIXED** | Independent memory-phase pauses followed by hold/revocation return empty lists/exports. Chromium's actual logout downloads contain no fenced draft.                                                            |
| R8-4 — stale revocation broadcast erases newer work        | **VERIFIED FIXED** | Delayed original broadcast preserves newly authorized quota-only typing. Current revocations still remove it; opposite-kind, cleared-account and closed-database cases pass.                                   |
| R8-5 — old writers omit copy source                        | **VERIFIED FIXED** | Actual old-version writer successfully reopens after version-4 upgrade and creates a provenance-free summary; current `list` resolves its draft source and hides both title and body.                          |

## New findings

### R9-1 — High, BLOCKING: a later hold invalidates logout recovery silently

**Locations:** `apps/notes/src/logout.ts:27`, `:103`, `:115`.

Open Sign out while a draft is exportable, then hold its source before clicking Export drafts. The held warning was computed only once and never updates. Chromium downloads `{drafts: []}`, displays “Export saved — sign out”, and that button deletes the still-held draft. The user confirmed saving a recovery file, not discarding excluded work; there was neither a denial nor a discard warning.

**Fix:** keep held/unsaved state current throughout the dialog and revalidate settlement before completion. Export confirmation must cover the current retained work; excluded held drafts require cancellation/resolution or a separate explicit discard decision.

### R9-2 — High, BLOCKING: account-change responses erase held work without settlement

**Location:** `apps/notes/src/session.ts:225`–`:234`.

After A's session expires, a successful session response for B immediately calls `clearAccount(A)` without `prepareLogout` or equivalent recovery handling. Independent session and Chromium integration probes retain A's held draft through expiry, then verify its deletion and the absence of a recovery dialog on the B response. This is a newly exercised pre-existing path; the browser probe controls the session response, not a real credential exchange. Ordinary expiry and learned device revocation behave correctly in separate probes.

**Fix:** settle prior-account unsaved work before destructive account-switch cleanup. Keep A's data isolated while that decision is pending; a different authenticated identity is not a denial of A's note access.

### R9-3 — High, BLOCKING: retired memory snapshots reopen and overwrite newer drafts

**Locations:** `apps/notes/src/cache.ts:290`, `:305`, `:328`, `:612`; `apps/notes/src/App.tsx:460`.

Pause a read after it captures a quota-failed recovery snapshot. Successfully retry that draft, retiring its memory entry, then write newer durable text from another store. Resume the read: the captured snapshot still wins over the newer transactional rows. Independent probes reproduce stale `read`, `list` and `exportDrafts` results. Chromium selection opens the old local-draft text while IndexedDB contains the newer text; editing that stale view overwrites the newer durable draft.

**Fix:** revalidate captured memory snapshots against their current identity/version before overlaying durable results, including `readDraft`. Invalidate or retry pending selection when its draft changes. Preserve genuinely unsaved newer snapshots without reviving retired ones.

## Remaining release gates

Resolve R9-1–R9-3 and independently rerun the preserved probes. Keep the documented pre-alpha legacy-journal transition gap, remaining consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r9-a4e2120/`. `SITE_URL` was restored and read back as `http://localhost:5178`. No commits, pushes, deployments, production requests or tracked-file changes were made. The detached review worktree was removed; main and notes-core status are clean.
