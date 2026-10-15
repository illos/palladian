# Palladian — independent Astra review, round 5

Date: 2026-10-15  
Commit: **`ceeaf70ff2a0e6df64f17eaebee44cf74357c4e4`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

Two core blockers remain: recovery can erase or misplace collaborator edits, and unsent conflict copies escape notebook-revocation cleanup. The formatting regression is fixed. Edge implementation is unchanged and its checks pass. This is scoped implementation review, not complete-v1 acceptance.

## Independent evidence

Reviewed the round-4 report, implementation response, changed code, and relevant collaboration/privacy contracts; applied the Convex reviewer checklist. Created the requested detached worktree and installed with `pnpm install --frozen-lockfile`.

| Check                                      | Result                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Notes-core Node tests                      | 28 passed                                                                  |
| Backend Vitest                             | 41 passed                                                                  |
| Frontend Vitest / Node tests               | 24 / 14 passed                                                             |
| Edge Vitest                                | 64 passed                                                                  |
| Core, backend and edge typechecks          | Passed, including Convex and edge contracts                                |
| App typecheck                              | Source check passes; tools/tests check fails on two unused constants, R5-3 |
| Independent preserved/adapted/new probes   | Frontend/core 32, backend 8, edge 3 passed                                 |
| Desktop and mobile-emulated Chromium suite | 40 passed, temporary configuration on port 5182                            |
| Production-build offline suite             | 2 passed, synthetic libraries of 1 and 2,000 notes                         |

The **43 independent probes include assertions reproducing defects**. Frontend probes use fake IndexedDB and controlled transport responses, with actual ProseMirror transforms and collaboration rebasing. Backend probes use `convex-test` with mocked identities. Edge probes include SQLite concurrency and MCP cursor transport. A deterministic structural probe applied 30,000 hostile candidate steps, checking every accepted result with full-document validation; no bypass was reproduced. Candidates included nested malformed slices, open slices, ReplaceAround gaps, forbidden marks and unsafe attributes. Repository tests additionally exercise real editor commands, joins, lifts, and list operations.

Atomic split probes confirm two concurrent stores create only one copy, and that account clearing, source-note revocation, or a newer durable draft prevent a stale split. These successes do not cover the subsequent-copy privacy failure below.

**Actual local services and Chromium:** the live script passed all 11 steps, including quote/list formatting reaching the second device, offline recovery, sharing and revocation. The adapted independent Quote probe saved successfully and retained the blockquote after reload. OAuth/MCP `e2e.mjs` passed all 31 steps; Worker consent-browser proof passed all eight steps.

**Unavailable/unperformed:** mobile WebKit could not launch because host libraries are missing; one launch failed and 19 cases did not run. No physical iPhone or production checks were performed.

## Round-4 findings

| Finding                                             | Status             | Verification                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-1 — broad recovery diffs erase independent edits | **PARTIALLY**      | Both preserved emoji and 2,100-character cases now preserve collaborator text through `reconcileCreated`, durable journaling and actual rebasing. Budget exhaustion returns null and retains both versions. However, exact-result diffing still generates destructive replacements for formatting and mismatches changed blocks: R5-1. |
| R4-2 — valid quote/list formatting rejected         | **VERIFIED FIXED** | Adapted original command and backend probes now accept wrapping. Real Chromium Quote saves and survives reload; the full live script verifies quote and list propagation. Preserved malformed-checkpoint and unsafe-link mutation probes still reject their batches. No new structural-validation defect was reproduced.               |

## New findings

### R5-1 — High, BLOCKING: exact recovery diffs still corrupt concurrent work

**Locations:** `packages/notes-core/src/document.ts:267`, `:319`, `:375`; recovery consumer `apps/notes/src/live.ts:548`.

Verified counterexamples:

- Base `Alpha middle Omega`; local applies bold without changing any text; collaborator inserts `COLLABORATOR ` before `middle`. Because inline matching includes marks, recovery emits one text replacement. Actual ProseMirror rebasing deletes the collaborator's insertion. The probe also invokes `reconcileCreated` and verifies that this destructive sequence is the durable recovery journal.
- Local uppercases the endpoint words and inserts a new paragraph, `Introduction`, before the original paragraph. The original paragraph retains its block ID. Collaborator replaces `middle` with `COLLABORATOR`. Kind matching pairs the old paragraph with the newly inserted paragraph. Rebasing produces paragraphs `IntroCOLLABORATORuction` and `ALPHA middle OMEGA`, instead of `Introduction` and `ALPHA COLLABORATOR OMEGA`.
- Swapping two existing paragraphs also reproduces exact local content while losing a collaborator's insertion into the moved first paragraph.

All generated sequences reproduce the local target's content before rebasing. That equality does not establish safe correspondence or preservation of concurrent text.

**Fix:** separate mark changes from text identity and emit mark steps over retained text. Establish trustworthy block correspondence using retained identities where available; do not pair unrelated blocks merely by kind. For movement or ambiguous correspondence that cannot preserve concurrent edits, return null and use a privacy-safe conflict path. Add concurrent-edit assertions, not only exact-local-result assertions.

### R5-2 — High, BLOCKING: pending conflict copies survive notebook revocation

**Locations:** `apps/notes/src/cache.ts:924`, `:933`; interaction with `:734` and `:454`.

`splitConflict` gives the copied draft a new local ID and a summary without `role` or source-note linkage. `reconcileAccess` deliberately excludes summaries without a role, treating them as independently authored local notes. Export filters revocation by the new ID only.

Verified through `syncDrafts`: force an unmergeable conflict in a shared notebook, interrupt creation of the resulting copy, then deliver a complete access snapshot removing the notebook and all note grants. The original note is purged, but the unsent copy remains in `localDrafts` and `exportDrafts`, including confidential text inherited from the source. This violates confirmed D86: unsaved work cannot be exported after notebook access removal. This is a local privacy failure; no backend authorization bypass is claimed.

**Fix:** retain source-note/notebook authorization provenance on pending conflict copies. Revocation cleanup and export must evaluate and purge dependent copies; creation must not detach inaccessible source material from its authorization boundary. Preserve atomicity and retry identity while doing so.

### R5-3 — Low, NON-BLOCKING: app tools/test typecheck fails

**Locations:** `apps/notes/tests/unit/review-round4.test.ts:14`, `:23`.

`pnpm --filter @palladian/notes typecheck` fails with TS6133 for unused `row` and `summary`. Reproduced both before adding review probes and after removing them. The first, app-source TypeScript check succeeds; the subsequent tools/test check fails.

**Fix:** remove the unused fixtures or use them in meaningful assertions, then rerun the package typecheck.

## Remaining release gates

- Fix R5-1 and R5-2 and independently rerun the preserved probes; clear R5-3.
- Complete browser-level stale-subscription/revocation and recovery-race coverage, including pending conflict copies, plus remaining consent-transfer, permission-reduction, account-switching and invitation-failure cases.
- Retain physical iPhone/Safari, representative-library performance, large-history, device-recovery, backup/restore, named MCP-client and remaining v1 gates. Synthetic browser/MCP harnesses do not establish those acceptances.

Probes and logs: `/tmp/palladian-astra-review-r5-ceeaf70/`. `SITE_URL` was restored and independently read back as `http://localhost:5178`. No tracked files, commits, pushes, deployments or production data were changed.

The detached review worktree was removed without force. Main and notes-core `git status --porcelain` are empty.
