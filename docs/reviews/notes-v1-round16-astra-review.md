# Palladian — independent Astra review, round 16

Date: 2026-10-15  
Reviewed commit: **`b6a4b2e9a604222fc87d3bedcda06736dd25d6fe`**

**Core: NOT ACCEPTED — two verified blocking privacy findings.**  
**Edge: ACCEPTED.**

The original round-15 reproductions are fixed. Operation identities prevent their destructive retries, and legacy notifications preserve newer recovery. However, joining a background retry can conceal failed cleanup, and retained legacy recovery bypasses epoch validation through the editor's draft-read path. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read round 15, its implementation response, the source/test diff and relevant product, privacy and delivery contracts. Used the requested detached worktree and frozen install. Backend, edge and shared-core source are unchanged.

- **Repository checks:** all package typechecks passed, including Convex. Tests passed: notes-core 28; backend 42; frontend 81 Vitest plus 19 Node; edge 64.
- **Independent integration:** 106 preserved/adapted frontend probes plus ten new operation/privacy probes passed; ten preserved backend probes and three edge probes also passed. These use actual store/session implementations with fake IndexedDB, native Node Web Locks/BroadcastChannel, controlled authentication and injected storage faults. Backend identities and edge persistence are test substitutes.
- **Actual Chromium:** 40 repository cases, 100 preserved/adapted reviewer cases and 26 additional round-15/16 cases passed across desktop and mobile emulation. Two production-build offline cases passed. React, IndexedDB, localStorage, Web Locks and BroadcastChannel are real; authentication, service responses and fault timing are controlled. The original transaction-gated overlap now preserves new work. Both new blockers were reproduced through the visible editor, not merely internal-map inspection.
- **Actual local services:** existing anonymous Convex deployment, pinned September 28 binary with `--skip-push`, and local Wrangler. OAuth/MCP proof passed all 31 steps. Chromium consent proof passed all eight steps, including live MCP note delivery, disconnect and No access.

Operation probes covered concurrent distinct decisions with initially unknown lifecycles, separate known lifecycles, late failure after another operation settled, retained results, accumulation, reload/carried cleanup, and queued/held/in-progress shutdown. Different known lifecycles retained independent completion and lock ownership. Forty finished records accumulated until same-account activation removed them; that removal exposes R16-3. Reload after a committed block safely finished deletion and spared subsequent new work. No additional wildcard-settlement failure was reproduced.

Initial overlap assertions expected the old public-call count and then expected failure propagation. The count changed because background retries now call `attemptClear` directly; the missing failure led to R16-1. Final overlap assertions verify new-work survival without masking that separate defect. Two initial integration probes needed to wait for actual invalidation/lock release before activation. Initial logs are preserved. No production, mobile WebKit or physical iPhone checks were performed.

## Previously open findings

Statuses distinguish the original reproduced failures from new gaps below.

| Finding                                                      | Status             | Verification                                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work   | **VERIFIED FIXED** | Hold/access-verification regressions pass. Unknown-lifecycle and overlapping-retry cases now preserve newer held work.                                                                             |
| R9-2 — account change erases held work                       | **VERIFIED FIXED** | Switch settlement, cancellation, export and receiving-tab regressions pass; original later-lifecycle deletion paths preserve drafts.                                                               |
| R12-1 — receiving cleanup erases a later lifecycle           | **VERIFIED FIXED** | Atomic carried cleanup, stale hints, numbered notifications and actual old-version delayed notifications preserve later durable/memory work.                                                       |
| R14-1 — owned retries regain destructive authority           | **PARTIALLY**      | Original known/unknown lifecycle and overlapping-session cases pass. Replaying an operation after same-store activation still regains authority: R16-3.                                            |
| R15-1 — unknown lifecycle remains unrestricted               | **VERIFIED FIXED** | Initially empty tab, failed block, automatic success, another tab's new accessible/held draft, then original session retry: new work survives in integration and Chromium.                         |
| R15-2 — overlapping same-tab clears retarget later lifecycle | **VERIFIED FIXED** | Joined integration retries and original real-IDB transaction-gated Chromium overlap leave new work intact beyond the retry delay. Background rejection semantics remain defective under R16-1.     |
| R15-3 — legacy notification destroys newer recovery          | **VERIFIED FIXED** | Delay a genuine `ce68554` notification across activation; quota-failed newer typing remains exportable after sign-in, in integration and Chromium. Genuine old-lifecycle revocation exposes R16-2. |
| R15-4 — queued acquisition survives close                    | **VERIFIED FIXED** | Queued clear rejects with `AbortError`; no acquired hold or retry remains. Held and in-progress shutdown also permit another store to activate.                                                    |

R13-1/2 and R14-2/4/5 regression cases pass. R13-3/R14-3's broader genuine-cleanup guarantee is reopened by R16-1. Round-5–13 fence, search, export, dependent-copy, recency and settlement regressions pass within their existing scope.

## New findings

### R16-1 — High, BLOCKING: joining a background failure treats cleanup as completed

**Locations:** `apps/notes/src/cache.ts:667–671`, `:621`, `:815`; `apps/notes/src/main.tsx:67–69`; `apps/notes/src/session.ts:287`.

An authoritative revocation fails to persist its account block. Start a sign-in check before the automatic retry, delay its authentication response, and gate the retry inside its real block transaction. Release authentication so the session's cleanup joins `op.running`; then fail the block write again.

The background promise has `.catch(() => false)`, so the joining session receives fulfillment rather than rejection. Its adapter ignores the boolean, drops pending cleanup and activates. Same-store activation bypasses its own held lock; because no block was recorded, it retains the revoked data. The session becomes Connected and the old private draft is exportable and visible in the editor. The clearing page remains alive throughout.

Verified in session integration and desktop/mobile Chromium using actual transaction ordering.

**Fix:** retain the rejecting attempt promise in `op.running`; attach a separate background rejection observer. Joining callers must observe failure. Prevent activation from bypassing unfinished mandatory cleanup.

### R16-2 — High, BLOCKING: legacy-retained revoked recovery reaches the editor

**Locations:** `apps/notes/src/cache.ts:766`, `:1446–1459`; `apps/notes/src/App.tsx:436`, `:473`, `:485`.

Create quota-failed memory recovery, then genuinely clear that lifecycle using the `ce68554` store. Its unnumbered notification hides the current tab but retains memory. Sign in again: the account epoch advances from 0 to 2. Export and ordinary body reads correctly exclude the old snapshot, but `readDraft()` reads `recoveryDrafts` directly without checking its fence.

When current server content for the same note is cached again, opening it selects the revoked draft's old base document. Both Chromium profiles visibly display the old private text, despite an empty export and current server content in the library. Integration also confirms the mismatched epochs and leaked draft.

**Fix:** apply account-epoch and asynchronous invalidation fences to `readDraft()` and every consumer of retained snapshots. Preserve legitimate same-lifecycle recovery while making genuinely ended recovery permanently inaccessible.

### R16-3 — Medium, NON-BLOCKING: activation forgets completed operation identity

**Locations:** `apps/notes/src/cache.ts:1036–1038`, `:603–612`.

Complete operation `logout`, activate the same store and write a new draft. Activation deletes the completed record. Calling `clearAccount(account, "logout")` again creates a new operation bound to the new lifecycle and deletes that draft. Verified in integration and both Chromium profiles. No current production UI path for this replay was established, so this is an API-contract defect rather than another demonstrated UI blocker.

**Fix:** retain safe completion identity for possible retries, or encode immutable lifecycle authority so retired IDs cannot be recreated against the current lifecycle.

## Remaining release gates

Resolve R16-1/2 and independently rerun their transaction/editor reproductions. Resolve or explicitly constrain R16-3's retry contract. Retain the documented stop-before-block gap, database-only fallback qualification, legacy-journal transition, broader actual-service account-switch/consent-transfer/permission-reduction/invitation-failure coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates.

Artifacts: `/tmp/palladian-astra-review-r16-b6a4b2e/`. No tracked-file changes, commits, pushes or deployments. Local `SITE_URL` was restored and compared byte-for-byte. Started services and preview tabs were stopped; the detached worktree was removed. Main and notes-core status are clean.
