# Palladian — independent Astra review, round 12

Date: 2026-10-15  
Commit: **`02697652ac12acd6d9a2b20a7d331904c85637ee`**

**Core: NOT ACCEPTED — one verified blocking finding.**  
**Edge: ACCEPTED.**

Replacing retirement with sign-out-style settlement is consistent with D67 and substantially simplifies the design. Ordinary account switches now require settlement, and the R11-1/R11-4 fixes work. However, a receiving tab retains unbounded cleanup authority after another tab settles and clears the account. It can subsequently erase newly created durable work without settlement. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read the round-11 report, implementation response, relevant product contracts, and `fa45670..0269765` source/test diff. Backend, edge and notes-core are unchanged. Installed a detached worktree using the frozen lockfile.

- **Repository checks:** notes-core 28 tests; backend 42; frontend 65 Vitest plus 16 Node; edge 64. All passed. All four package typechecks passed, including backend Convex, before adding untracked reviewer probes.
- **Independent unit/integration probes:** 74 preserved/adapted frontend, six new frontend, ten backend and three edge checks passed, including assertions reproducing the blocking defect. These use fake IndexedDB, controlled session/transport responses, real ProseMirror transforms, backend `convex-test` with mocked identities, real BroadcastChannel delivery, and edge SQLite/concurrency checks.
- **Actual Chromium:** 40 repository desktop/mobile-emulated cases, 50 preserved/adapted reviewer cases, and 18 distinct round-12 desktop/mobile-emulated cases passed. Two production-build offline cases also passed. These exercise actual React, IndexedDB, BroadcastChannel, downloads and multiple tabs; authentication responses, quota failures and race timing are controlled. The blocking cleanup reproduction passed in both browser profiles, for accessible and held durable work.
- **Specific switch checks:** both tabs seeing B; logout during the switch dialog; cancelling logout and switch, then retrying; export and saved-file confirmation; held work refusing empty-export confirmation; explicit discard; settlement exceptions/declines preserving A without scheduling automatic retry.
- **Settlement checks:** the original R11-4 Chromium replacement/hold interleaving now retains the memory-only draft and prevents cleanup. Real quota-failed replacements during settlement succeed after one or four changes; five changes reject, retaining recovery. Browser confirmation reports “could not be checked” under persistent version churn.
- **Probe corrections:** old retirement expectations were replaced with settlement expectations. A preserved mobile assertion now checks the access message exists in the hidden editor pane; privacy assertions remain unchanged. One new test initially retried before asynchronous export confirmation finished, cancelling it; the corrected test awaits completion. Initial logs remain available; these failures are not product findings.
- **Not run:** actual Convex/Worker authentication, OAuth/MCP or consent-browser proofs; mobile WebKit; physical iPhone; production requests. Only local Playwright-managed Vite/preview services were used. Earlier live-service evidence remains historical; `SITE_URL` was not changed.

## Still-open findings from earlier rounds

| Finding                                                    | Status                      | Verification                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-4 — stale notebook association destroys authorized work | **PARTIALLY**               | Hold, positive-verification, denial and stale-verdict probes pass. Held durable recovery remains vulnerable to R12-1 across account lifecycles.                     |
| R8-1 — sign-out destroys held work                         | **VERIFIED FIXED**          | Held-work dialogs, Cancel, offline Wait, changing holds and explicit discard pass in Chromium. R12-1 is a separate later cleanup bypass.                            |
| R9-1 — later hold invalidates logout recovery              | **VERIFIED FIXED**          | Hold-start/end, changed-document fingerprints and the original replacement-memory confirmation race pass. Held work cannot confirm an empty export.                 |
| R9-2 — account change erases held work                     | **PARTIALLY**               | Direct switches settle before clearing; cancellation/error preserves A. Receiving-tab cleanup still erases later accessible or held work without settlement: R12-1. |
| R10-2 — retirement drops its only snapshot                 | **OBSOLETE (removed code)** | Retirement storage/save/restore paths are gone. Quota-only recovery and replacement-settlement probes pass on the remaining path.                                   |
| R10-3 — delayed retirement saves undo clearing             | **OBSOLETE (removed code)** | Retirement saves are removed; remaining stale-write/account-fence regression probes pass.                                                                           |
| R10-4 — confirmation combines inconsistent reads           | **VERIFIED FIXED**          | Preserved Chromium hold-during-confirmation reproduction passes, as do replacement-memory and bounded-retry checks.                                                 |
| R11-1 — connected receiving tab stays blocked              | **VERIFIED FIXED**          | Previously connected receiving tab signs in again, unblocks its account, writes a fresh draft and displays it without reload, in desktop and mobile Chromium.       |
| R11-2 — old preservation survives clearing                 | **OBSOLETE (removed code)** | Both offending preservation paths are removed. R12-1 concerns stale destruction, not restored content.                                                              |
| R11-3 — overlapping retirement strands recovery            | **OBSOLETE (removed code)** | Retirement/restoration ownership transfer is removed.                                                                                                               |
| R11-4 — settlement omits replacement memory                | **VERIFIED FIXED**          | Original Chromium reproduction now keeps the draft; independent quota-replacement/churn probes verify retry and failure behavior.                                   |

The previously fixed R9-3/R10-5 recency cases and round-5–10 hold, fence, broadcast, search, export and dependent-copy regressions also pass. Retirement-specific R10-1 behavior is superseded by the new design.

## New findings

### R12-1 — High, BLOCKING: stale receiving-tab cleanup erases a later account lifecycle

**Locations:** `apps/notes/src/session.ts:110–114`, `:230–258`; receiving hooks in `apps/notes/src/main.tsx:100–112`.

Verified sequence:

1. Two tabs are connected as A. Tab 1 sees B, opens settlement, and the user explicitly discards A's old draft.
2. Tab 2 receives invalidation and becomes signed out. `adoptInvalidation` also stores `pendingCleanup = A`.
3. Tab 1 signs in again as A and writes a **new durable draft**. A second reproduction places this new draft on hold; settlement reports `{total: 1, held: 1}`.
4. Tab 2 signs in as A. Its displayed account is null, so the account-switch settlement branch is skipped. The old `pendingCleanup` unconditionally invokes `clearAccount(A)`.
5. The new draft is deleted, export is empty, and Tab 1 is signed out by the new invalidation. Neither tab settled the new work; there was no authoritative revocation.

This is reproduced independently with fake-IDB/session controllers and actual two-tab Chromium. It is **durable data loss**, outside the documented exception for another tab's memory-only snapshots.

**Required fix:** scope cleanup intent and retries to a durable account/cleanup generation, validating it atomically with deletion. A receiving notification must distinguish already-completed cleanup from cleanup still requiring completion. Old intent must become harmless after a fresh activation; it must not authorize deletion of that lifecycle's work. Preserve fencing and genuine failed-cleanup recovery, and add the above two-tab regression for accessible and held drafts.

## Remaining release gates

Resolve R12-1 and independently rerun the receiving-tab lifecycle probes before core acceptance. Keep the legacy-journal transition gap, remaining real-service consent-transfer/permission-reduction/account-switch/invitation-failure browser coverage, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates pending.

Artifacts: `/tmp/palladian-astra-review-r12-0269765/`. No tracked-file edits, commits, pushes, deployments or production requests were made. The detached review worktree was removed, all started services stopped, and main and notes-core status are clean.
