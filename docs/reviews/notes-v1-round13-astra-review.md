# Palladian — independent Astra review, round 13

Date: 2026-10-15  
Commit: **`95f5415c4308e6e136db9acf89657516a166d216`**

**Core: NOT ACCEPTED — three verified blocking findings.**  
**Edge: ACCEPTED.**

The original sequential R12-1 reproduction now preserves accessible and held work. However, cleanup authority is still inferred from separately read, unversioned records. Controlled interleavings and storage failures reproduce later-lifecycle data loss and a regression that forgets required revocation cleanup. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read the round-12 report, implementation response, relevant session/privacy and delivery contracts, and `0269765..95f5415` diff. Installed the specified detached worktree with the frozen lockfile. Backend, edge and notes-core source are unchanged.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 67 Vitest and 18 Node; edge 64. All passed. All four package typechecks passed, including backend Convex, before adding untracked reviewer probes.
- **Independent integration checks:** 80 preserved/adapted frontend probes, 15 new round-13 probes, ten backend probes and three edge probes passed. These use real store/session implementations with fake IndexedDB, controlled auth responses, injected persistence failures, real BroadcastChannel delivery, ProseMirror transforms, `convex-test` with mocked identities, and edge SQLite/concurrency checks. Passing reproduction assertions confirm the defects below.
- **Previous-code control:** one additional probe using the unmodified round-12 session controller completes the failed revocation cleanup on retry; round 13 skips it.
- **Actual Chromium:** 40 repository, 50 preserved reviewer, 18 adapted round-12 and ten round-13 desktop/mobile-emulated cases passed. Both production-build offline tests passed. Browsers exercise actual React, IndexedDB, localStorage, BroadcastChannel, multiple tabs and downloads; authentication, storage failures and race timing are controlled. Accessible and held variants of both new data-loss reproductions passed in both profiles.
- **Probe correction:** the initial revocation browser probe bypassed the app's activation-fence capture, so readiness correctly failed. Preserving that wrapper while changing only the returned auth result reproduced R13-3. Initial and corrected logs are retained; the initial failure is not a product finding.
- **Actual services:** only Playwright-managed local Vite/preview servers. No actual Convex/Worker authentication, OAuth/MCP or consent-browser proof was rerun. No production requests, mobile WebKit or physical iPhone checks. The implementer's production evidence was not independently reverified; `SITE_URL` was unchanged.

## Still-open findings

| Finding                                                    | Status        | Verification                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY** | Preserved hold, positive-verification, denial and stale-verdict regressions pass. Held durable work remains vulnerable to R13-1/R13-2.                                                                                        |
| R9-2 — account change erases held work                     | **PARTIALLY** | Direct switches still settle; cancellation/error preserves work. Receiving-tab cleanup still bypasses settlement in R13-1/R13-2.                                                                                              |
| R12-1 — stale receiving cleanup erases a later lifecycle   | **PARTIALLY** | Original accessible/held reproduction passes in integration and both Chromium profiles, as does constructor-carried intent after a fresh activation. Concurrent activation and failed hint replacement still permit deletion. |

R8-1, R9-1, R10-4, R11-1 and R11-4 remain verified fixed within their prior scope. The round-5–12 fence, search, export, dependent-copy, recency, quota-recovery and settlement regressions pass; removed retirement findings remain obsolete.

Additional targeted checks confirm that a newer settled cleanup can legitimately be completed through either its current hint or blocked record; a rejected blocked-state read retains cleanup; committed clears reject pre-clear activation fences; stopping during the guard prevents deletion. A second integration reproduction confirms that another tab replacing the hint after a failed clear can cause required cleanup to be forgotten, as in R13-3.

## New findings

### R13-1 — High, BLOCKING: blocked-state check races with fresh activation

**Locations:** `apps/notes/src/session.ts:245–250`, `:273–280`; `apps/notes/src/cache.ts:753–754`, `:549–585`.

After Tab 1 completes logout, Tab 2 retains adopted cleanup. Tab 2 retries and reads `accountBlocked(A) === true`; pause delivery of that result. Tab 1 signs in again, unblocks A, replaces the hint and saves a new durable draft. Resume Tab 2: its own generation is unchanged, so the stale `true` authorizes an unconditional clear. The draft disappears and Tab 1 becomes signed out, with no settlement of the new work. Verified for accessible and held drafts in integration and Chromium.

**Fix:** bind cleanup to the account lifecycle/cleanup generation and validate that authority atomically with deletion. A separate blocked read and tab-local generation check cannot protect another tab's later activation. Fence activation and invalidation notifications consistently with that generation.

### R13-2 — High, BLOCKING: failed hint replacement preserves destructive authority

**Locations:** `apps/notes/src/session.ts:241`, `:305–307`, `:350–357`.

Tab 1 persists the logout intent and successfully clears A. Its completion hint write fails; the old `pendingCleanup: A` remains. Tab 1 signs in again: activation succeeds, `remember(A)` also fails, and readiness is nevertheless published. It saves new durable work. When Tab 2 signs in, the stale hint alone authorizes deleting that work, despite the persisted account being unblocked. This requires no blocked-read race. Verified for accessible and held drafts in integration and both Chromium profiles.

**Fix:** a hint naming the account must not independently authorize clearing an activated later lifecycle. Use generation-bound cleanup evidence and invalidate old cleanup authority as part of activation, even when localStorage is unwritable. Merely reordering the two current boolean checks would not resolve R13-3.

### R13-3 — High, BLOCKING: missing persistence evidence discards genuine failed cleanup

**Locations:** `apps/notes/src/session.ts:199–207`, `:245–250`; `apps/notes/src/cache.ts:556–585`, `:753–754`.

An authoritative revocation arrives. Inject failure of the logout-hint write and abort the clear transaction. The controller retains required cleanup in memory, but the hint remains the old account pointer and the persisted account remains unblocked: the blocked flag shares the aborted deletion transaction. Restore storage and sign in again. The new guard drops the cleanup, activation unblocks the local store, and the old draft becomes visible/exportable without any successful clear. Verified with real IndexedDB in Chromium and fake-IDB integration. The round-12 control retries deletion successfully.

A delayed receiving tab can also replace the hint while another tab's clear remains failed, producing the same skip without an initial hint-write failure.

**Fix:** distinguish known unfinished local cleanup from completed foreign cleanup. Absence of a hint or blocked record is not proof of completion or a newer lifecycle. Retain and retry known required cleanup until completion or verified supersession; coordinate that evidence with activation and reload recovery.

## Remaining release gates

Resolve R13-1–R13-3 and independently rerun receiving-tab, storage-failure and lifecycle-interleaving probes before core acceptance. Keep the legacy-journal transition gap, remaining real-service consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r13-95f5415/`. No tracked-file edits, commits, pushes or deployments. The detached review worktree was removed, started servers stopped, and main and notes-core status are clean.
