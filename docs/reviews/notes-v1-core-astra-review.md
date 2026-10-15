# Notes v1 core — independent Astra review

Date: 2026-10-15  
Status: **not accepted** — protected authentication, authorization, privacy, and persistence findings require fixes before production.

## Scope and evidence

Reviewed detached commit **`8de858002075708b5dd23c816eb31fdc6ebc2ff3`**, covering `packages/notes-core/src`, `apps/notes-backend/convex`, and the specified frontend sync, cache, consent, sharing, and integration paths. Read the delivery plan, D91–D94, authorization/document contracts, `AGENTS.md`, and prior foundation review. Applied the Convex reviewer checklist.

Excluded the MCP/OAuth Worker, visual design, and shelved platform.

Independently ran, relative to the detached worktree:

- `pnpm install --frozen-lockfile`: passed; Node **24.18.0**, pnpm **11.5.3**.
- In `packages/notes-core`: `node --experimental-strip-types --test tests/*.test.ts`: **17 passed**.
- In `apps/notes-backend`: `npx vitest run`: **17 passed**; `npx tsc --noEmit -p convex/tsconfig.json`: passed.
- In `apps/notes`: `npx tsc --noEmit`: passed; `node --experimental-strip-types --test tests/*.test.ts`: **14 passed**.
- In `apps/notes-backend`: `npx vitest run tests/astra-review.test.ts`: **6 reproduction probes passed**.
- In `apps/notes`: `../notes-backend/node_modules/.bin/vitest run --config ../notes-backend/vitest.config.ts tests/astra-review.test.ts`: **5 reproduction probes passed**.

The probes assert the defective behavior described below. Backend evidence uses in-memory `convex-test`; frontend evidence uses ProseMirror state, controlled adapters, and `fake-indexeddb`. No actual-service, browser, or physical-iPhone checks were independently run. Read `live-e2e.mjs`; its reported success remains implementer evidence.

No tracked files were modified. Temporary probes were removed after copying them to `/tmp/palladian-astra-review-8de8580/`. Verified empty `git status --porcelain`, then removed the review worktree. No commits, pushes, or deployments.

## BLOCKING — must fix before production

1. **High — Raw document writes bypass URL sanitization.**  
   `packages/notes-core/src/document.ts:15`, `packages/notes-core/src/schema.ts:169`, `apps/notes-backend/convex/documents.ts:165`.  
   Sanitization runs during Markdown/DOM parsing, but JSON creation and submitted steps rely on `doc.check()` without attribute validators. A probe successfully persisted a `javascript:` link through creation and an otherwise-disallowed HTTP image through `push`. Rendering emits those attributes verbatim. **Fix:** enforce URL and attribute validation on every server write, including steps; add defensive rendering checks.

2. **High — Convex tokens are labelled with an assumed account.**  
   `apps/notes/src/live.ts:128`.  
   If credentials change to B while the session controller still records A, the callback accepts B’s token and stores it under A. It checks only the controller’s account string after fetching; it does not verify token subject or require the captured generation to remain current. A controlled probe confirmed acceptance of a B-subject token under A. Subsequent library caching uses A’s account key. **Fix:** bind token acquisition and authenticated readiness to the verified account, credential/session generation, and request generation.

3. **High — Note-access loss does not invalidate all local copies.**  
   `apps/notes/src/cache.ts:465`, `apps/notes/src/App.tsx:203`, `apps/notes/src/App.tsx:271`.  
   Removal deletes IndexedDB rows but establishes no persistent note-level fence. Probes confirmed that an old response can recreate the deleted body and another store instance can still export its in-memory recovery draft. The open reader ignores null content, and `makeChannel` supplies no `onAccessLost` handler, leaving inaccessible content displayed. **Fix:** persist and broadcast note invalidation, fence queued responses/writes/exports, and clear the open editor and recovery memory.

4. **High — Shared-note reconciliation misses revocation and can discard authorized drafts.**  
   `apps/notes/src/live.ts:215`, `apps/notes/src/live.ts:294`, `apps/notes/src/cache.ts:525`.  
   After restart, `sharedIds` is empty. An individually shared note revoked while the app was closed is therefore absent from both the new result and the calculated removals; a probe confirmed no removal. Conversely, notebook removal can delete a note’s pending work before the separate shared-note subscription reports its surviving explicit grant. **Fix:** reconcile persisted cached access against a complete authorization snapshot, resolving explicit grants before deleting content or pending work.

5. **High — Late search results can disclose the previous account’s excerpts.**  
   `apps/notes/src/App.tsx:219`, `apps/notes/src/App.tsx:505`.  
   Search completion calls `setHits` without account, generation, or request checks. Logout clears current hits, but an already-running search can restore them afterward; `extraHits` is rendered without the account permission filter applied to cached rows. **Fix:** fence requests and results by account/generation, invalidate pending callbacks during cleanup, and account-scope rendering.

6. **High — Creation replay bypasses current authorization.**  
   `apps/notes-backend/convex/notes.ts:111`, `apps/notes-backend/convex/notes.ts:148`.  
   A collaborator creates a note, loses access, and repeats the creation request. `createFromMarkdown` returns the note’s current title without checking `noteRole`. The probe retrieved a new private title written after revocation. Native creation similarly exposes the current revision. **Fix:** check current effective access before returning either replay result.

7. **High — Consent “No access” selections are ignored on reconnect.**  
   `apps/notes/src/pages.tsx:116`, `apps/notes-backend/convex/connections.ts:48`, `apps/notes-backend/convex/connections.ts:63`.  
   The UI omits notebooks selected as “No access”; approval only upserts submitted memberships. Existing access survives. An unchecked future-sharing box likewise leaves `autoShareRole` enabled. The probe confirmed both. **Fix:** submit and apply explicit removals and the complete future-sharing choice atomically; make retained grants/delegations visible in consent.

8. **High — Revoked invitations can finish granting access.**  
   `apps/notes-backend/convex/invitations.ts:283`.  
   `complete` checks only existence and prior acceptance. Revoking an invitation after `claim`, while account creation runs, does not prevent completion. A probe executed claim → revoke → complete and observed an edit membership. Expiry and claim ownership are also unchecked here. **Fix:** revalidate revocation, expiry, and a unique claim generation at final commit, with recoverable handling of partially created auth accounts.

9. **High — Reopening pending edits applies them twice.**  
   `apps/notes/src/App.tsx:352`, `apps/notes/src/editor.tsx:490`.  
   `store.read` supplies the draft document already containing pending edits. The editor initializes from that document, then replays `binding.pending`. Reproducing this initialization changed `Hello!` into `Hello!!` while retaining base revision zero. Structural steps can instead fail or corrupt synchronization. **Fix:** initialize collaboration from `baseDocument` and replay pending steps exactly once.

10. **High — Lost creation responses can silently discard later typing.**  
    `apps/notes-backend/convex/notes.ts:111`, `apps/notes/src/live.ts:387`.  
    Creation saves V1 but its response is lost. The local draft becomes V2; retrying the same key returns the existing revision-zero note without comparing payloads. `syncDrafts` then settles V2 as accepted and removes recovery, although the server still contains V1. The backend probe confirmed changed-payload replay returns the original revision zero. **Fix:** persist an immutable creation payload/receipt and submit subsequent changes separately; never infer content acceptance from revision zero alone.

11. **Medium — History reconstruction silently returns the wrong revision.**  
    `apps/notes-backend/convex/documents.ts:190`, `apps/notes-backend/convex/documents.ts:263`.  
    Checkpoints occur only at batch ends, while reconstruction reads at most 610 steps. A permitted insertion producing 700 ID repairs reached revision 701; reading revision 650 returned the document after only 610 steps, including incorrect block attributes. **Fix:** checkpoint within large batches or replay bounded pages to the exact target, asserting revision continuity.

## NON-BLOCKING

- **Medium — Separator replacement silently fails.** `packages/notes-core/src/edits.ts:235`: replacing the unique `"\n\n"` in `one\n\ntwo` with a space leaves two paragraphs. The probe confirmed this. Include both adjacent blocks when replacing a block separator.
- **Medium — Recent-note pagination can terminate prematurely.** `apps/notes-backend/convex/library.ts:200`: candidate limits precede authorization/Trash filtering. Enough excluded recent notes hide older accessible notes while returning `nextBefore: null`. Continue scanning with a stable cursor until the authorized page is filled or genuinely exhausted.

## Remaining release gates

Require independent rereview and regression coverage for these findings, followed by actual-service/browser proofs of revocation, retained overrides, account switching, lost responses, and journal reload.

Worker/OAuth signing and client binding remain separately reviewable. Physical iPhone/Safari, representative-library performance, large-document/history limits, password recovery and device revocation, claims/cancellation, public links, attachment lifecycle, and backup/restore evidence remain open. Passing the existing suites does not establish complete v1 acceptance.
