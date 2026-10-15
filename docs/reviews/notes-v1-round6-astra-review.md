# Palladian — independent Astra review, round 6

Date: 2026-10-15  
Commit: **`af38401ddb5ab230ef5ddf8fdf4b628de9c6469e`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

Four verified core blockers remain: stale recovery can overwrite newer accepted work; settlement can discard different content with the same timestamp; feed revocation leaves an open conflict copy visible; and notebook reconciliation can destroy still-authorized pending work. Edge implementation is unchanged and its checks pass. This is scoped implementation review, not complete-v1 acceptance.

## Evidence run

Read the round-5 report, implementation response, specification contracts and changed code; applied the Convex reviewer checklist. Installed the requested detached worktree using `pnpm install --frozen-lockfile`.

- **Repository tests:** notes-core 28; backend 42; frontend 36 Vitest plus 14 Node; edge 64. All passed. Core, backend, frontend and edge typechecks passed, including frontend tools/tests and edge contracts.
- **54 independent preserved/adapted/new probes:** frontend/core 41, backend 10, edge 3. All assertions passed, including assertions reproducing the defects below. Frontend probes use fake IndexedDB, controlled transport and real ProseMirror transforms; backend probes use `convex-test` with mocked identities. Edge probes exercise SQLite concurrency and MCP cursor transport. The structural probe checked 30,000 hostile candidate steps against full-document validation.
- **Browsers with synthetic fixtures:** 40 desktop/mobile-emulated Chromium cases passed. Two production-build offline cases passed with synthetic libraries of 1 and 2,000 notes. An additional T3 browser probe reproduced R6-3 using real IndexedDB/React and a synthetic feed-removal event.
- **Actual local services:** live Chromium proof passed all 11 steps; independent Quote-save/reload proof passed; OAuth/MCP proof passed all 31 steps; Worker consent-browser proof passed all eight steps. Used the existing Convex, Vite and Wrangler services.
- **Unavailable/unperformed:** mobile WebKit failed to launch because host libraries are missing; its cases establish no acceptance. No physical iPhone or production checks were performed.

## Round-5 findings

| Finding                                           | Status             | Verification                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-1 — recovery diffs corrupt concurrent work     | **PARTIALLY**      | Adapted bold-only, inserted-first-paragraph and swapped-paragraph probes preserve collaborator content by splitting; no-collaborator cases reproduce the local document. Repository tests also cover emoji and long paragraphs. Content/step-read races cannot bypass exact-revision rejection. Lost replies retain identity. However, the same recovery identity shared across tabs permits R6-1, and settlement permits R6-2. |
| R5-2 — pending copies survive notebook revocation | **PARTIALLY**      | The original stored-copy/export failure is fixed. Snapshot and explicit revocation purge copies, reject stale saves, and filter quota-failed memory snapshots across stores. Source-checked creation rejects inaccessible sources transactionally. Feed-removal notifications omit dependent copies: R6-3. Purging also overreaches: R6-4.                                                                                      |
| R5-3 — frontend tools/test typecheck fails        | **VERIFIED FIXED** | The complete package typecheck passes before installing review probes.                                                                                                                                                                                                                                                                                                                                                          |

Additional checks preserved account/marker fencing, atomic conflict splits and newer-draft rejection. Read-only recovery avoids steps/history; wrong-subject verification cannot create a copy. A failing creation does not block other drafts. Source-checked creation permits a reader to copy into their own notebook, rejects a new creation after revocation, and correctly replays an already-created copy. Backend callers cannot use the reserved `server` client ID; server repair steps follow their originating batch.

## New findings

### R6-1 — High, BLOCKING: an older tab overwrites newer settled recovery

**Locations:** `apps/notes/src/live.ts:586`, `:588`.

The exact-draft comparison runs only when `draft.clientId` is absent. Reproduction with two stores sharing IndexedDB:

1. Tab A starts recovery of “First draft” with an already-persisted recovery client ID; pause its content read.
2. Tab B saves “Newer work from tab B”, retaining that ID, recovers successfully, and retires the draft.
3. Resume A. It reads B's current revision, classifies B's steps as its own, skips `replaceDraftIf`, and successfully replaces B's accepted text with “First draft”. Both draft exports are empty afterwards.

Exact server revision checking does not prevent this: A deliberately sends against the newer revision. History retains the overwritten version, but the current note silently regresses and no recovery draft remains.

**Fix:** validate an unchanged, still-existing durable draft before **every** recovery send, including retries with an existing client ID; coordinate recovery across tabs. Recheck account/session and open-note state after asynchronous preparation. A separate probe confirmed that opening the note while the initial `replaceDraftIf` awaits still allows the send.

### R6-2 — High, BLOCKING: timestamp-only settlement deletes different content

**Locations:** `apps/notes/src/cache.ts:904`, `:917`; caller `apps/notes/src/live.ts:540`.

`settleDraft` compares only `updatedAt`, despite receiving the expected draft. A delayed content response equal to the old draft causes settlement to delete a newer, different document carrying the same timestamp, from both IndexedDB and memory. The probe ends with the old body and no exportable draft. App saves use `Date.now()`, so equal timestamps are possible, especially across tabs. Different-timestamp typing survives the control probe.

**Fix:** use a real draft generation or exact snapshot comparison, including document and journal state, for durable and in-memory retirement. Do not treat timestamp equality as content identity.

### R6-3 — High, BLOCKING: feed revocation leaves an open copy visible

**Locations:** `apps/notes/src/cache.ts:592`, `:602`; consumer `apps/notes/src/App.tsx:188`.

`cacheSummaries` discards the expanded IDs returned by `fenceNotes` and announces only the original `removed` IDs. Unlike explicit revocation and snapshot reconciliation, it omits dependent copies from both local notifications and broadcasts.

Verified in two-store probes and the actual browser: remove the source through the library-feed path while its pending copy is open. Stored drafts and exports disappear, but the copy's editor remains visible with confidential content. The app closes an editor only when its own ID appears in `revokedNotes`.

**Fix:** announce every fenced ID returned by `fenceNotes` on this path too. Test open copies in the receiving and originating tabs.

### R6-4 — High, BLOCKING: stale notebook provenance causes destructive over-purge

**Locations:** `apps/notes/src/cache.ts:775`, `:780`, `:784`; ordering `apps/notes/src/live.ts:311`, `:322`.

Move a source from notebook A into notebook B, which the collaborator can still edit; then remove their membership in A. A reconnecting device retains the old source summary and an unsent conflict copy. The complete access snapshot includes B, excludes A, and has no individual grant for the source. Reconciliation uses the stale A association and deletes the source's pending work and dependent copy **before** refreshing notebook feeds.

Backend probes verified this state through real mutation handlers and confirmed `verifyAccess` still returns edit access in B. Cache probes reproduced deletion; later positive verification restores source access but cannot recover the deleted local version. If the source summary already names B, the control probe preserves the copy.

**Fix:** verify current effective access before irreversibly purging work based on stale notebook association. Preserve the existing subject, epoch and revocation-marker protections; a cached summary must not lift a confirmed denial.

## Remaining release gates

Fix R6-1–R6-4 and independently rerun the preserved races and browser revocation probes. Retain the documented pre-alpha legacy-journal transition gap. Remaining consent-transfer, permission-reduction, account-switching and invitation-failure browser cases, physical iPhone/Safari, representative-library performance, large-history/device recovery, backup/restore, named MCP clients and complete-v1 gates remain pending.

Artifacts: `/tmp/palladian-astra-review-r6-af38401/`. `SITE_URL` was restored and read back as `http://localhost:5178`. No tracked files, commits, pushes, deployments or production data were changed. The detached worktree was removed; main and notes-core status are clean.
