# Palladian — independent Astra review, round 18

Date: 2026-10-15  
Reviewed commit: **`67e9e08758a1d3fabc960daebeaf13fbee20b312`**

**Core: ACCEPTED.**  
**Edge: ACCEPTED.**

R17-1 is verified fixed, closing the remaining R16-2 qualification. No new blocking or non-blocking findings were verified. This accepts the reviewed core and edge scope, not complete v1 or the remaining release gates.

## Evidence run

Read the round-17 report, implementation response, source/test diff and relevant recovery, privacy and delivery contracts. Reviewed the affected activation, snapshot, write, settlement and `LiveController` paths. Used the requested detached worktree and frozen-lockfile install. Only `cache.ts` changed in application source; backend, edge and shared-core source are unchanged.

- **Repository checks:** all four package typechecks passed. Tests passed: shared core 28 Node; backend 42 Vitest; frontend 85 Vitest plus 19 Node; edge 64 Vitest.
- **Independent integration:** 127 preserved/adapted frontend probes and 10 new probes passed. Ten preserved backend and three edge probes also passed. Frontend probes use actual store/session/recovery code with fake IndexedDB, Node Web Locks/BroadcastChannel, controlled service/authentication responses and injected storage faults. Backend and edge probes use test substitutes.
- **Actual Chromium:** 40 repository cases, 150 preserved/adapted reviewer cases and 34 new cases passed across desktop and mobile emulation. Two production-build offline cases passed. Browser IndexedDB, localStorage, Web Locks, BroadcastChannel and rendering are real; authentication/service responses and adversarial fault timing are controlled. Fourteen new cases include six consumer scenarios across three separate browser pages and a real page-reload recovery scenario, each in both profiles.
- **Negative controls:** six integration checks using an untracked copy of `cache.ts` from `61f2552` reproduced the original sticky-field contamination, replace/split refusals, recovery stalls and retained settlement snapshot. Corresponding current-code checks pass.

Local Vite development/preview servers were exercised. Convex/Wrangler services and live OAuth/consent proofs were **not rerun** this focused round. No production, mobile WebKit or physical iPhone checks were performed. Prior-round service evidence and implementer-reported production proofs are not counted as this review's execution.

## Previously open findings

| Finding                                                   | Status             | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R16-2 — legacy recovery bypasses draft-read fences        | **VERIFIED FIXED** | Original legacy-notification readers and visible-editor checks remain safe in integration and Chromium. Three-tab reactivation no longer leaves ended recovery available to the remaining consumers.                                                                                                                                                                                                                                                              |
| R17-1 — ended recovery controls later writes and recovery | **VERIFIED FIXED** | Both original activation ordering and separate-page A-saves-before-B-signs-in ordering pass. No old notebook/client/created/source fields enter a content-only write; `replaceDraftIf` and `splitConflict` succeed; three actual `LiveController.syncDrafts()` attempts send current work or create its conflict copy. An accepted-response probe sends once and settles successfully. Settlement leaves neither ended draft snapshots nor their fences retained. |

## Recovery and interleaving verification

The new purge records the activated epoch and compares snapshot identity after awaiting its fence. Controlled gates verified that replacement of the awaited key, replacement of an unvisited key, insertion of a new key and a successful save during the purge preserve current work. Typing between the activation transaction and purge also survives. Cancelling activation during the await produces the expected superseded-activation error.

Same-epoch quota-failed typing survives activation; offline typing before sign-in remains recoverable. Browser reload coverage first retries the unsaved snapshot durably before reloading, then verifies another quota failure after reload survives sign-in. This does not claim memory-only data survives page destruction.

Preserved R5–R16 coverage passes, including note fences, dependent copies, reader/search/export filtering, recency, settlement, account-switch cancellation, cleanup failures, close/reload behavior, overlapping decisions and completed-operation replay.

Initial new-probe runs exposed a reviewer teardown error (closing IndexedDB before awaiting the final read) and browser execution-context destruction. After fixing the untracked probe's await and rerunning with stable probe files, all focused cases passed. Initial and final logs are retained; these are not product findings.

## Remaining release gates

Retain the documented stop-before-block gap, database-only fallback qualification, legacy-journal transition, broader actual-service account-switch/consent-transfer/permission-reduction/invitation-failure coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates. This focused fix does not close them.

Artifacts and reproducible probes: `/tmp/palladian-astra-review-r18-67e9e08/`. No tracked-file edits, commits, pushes or deployments. `SITE_URL` was unchanged. Started frontend servers were stopped and their ports checked closed. The review worktree was removed; main's `git status --porcelain` is empty.
