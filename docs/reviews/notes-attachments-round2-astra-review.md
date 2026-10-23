# Inline attachments — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `8e7088a..04cf7a7` on `feat/notes-attachments`, after the round 1 responses. Report recorded verbatim below; responses are in `notes-attachments-implementation.md`.

---

CHANGES NEEDED

1. **R2-1 — blocking — Cleanup intent can disappear before the lifecycle marker is persisted.** [attachment-cache.ts:377](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:377), [attachment-cache-lifecycle.ts:67](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache-lifecycle.ts:67)  
   Reproduced with real Chromium IndexedDB and the real page/session harness: cache synthetic bytes, inject `QuotaExceededError` when writing the account marker, revoke the session, sign back into the same account before retry succeeds, then reload. The session clears its cleanup hint independently of attachment cleanup; the failed attachment marker never existed. **The old bytes become readable after reopening.** In-memory pending state correctly refuses them before reload.  
   **Fix:** preserve durable attachment-cleanup intent until deletion is verified, independently of session-hint resets, and complete it before reactivating cached bytes. Database unavailability must not count as successful deletion. Add failure-before-marker/relogin/reload coverage. F2 is only partially resolved.

2. **R2-2 — blocking under the requested gate-off release contract — Existing web images gain new behavior while files are off.** [editor.tsx:806](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor.tsx:806), [attachment-views.ts:406](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-views.ts:406)  
   Attachment node views are installed unconditionally. With `setFiles(false)`, an existing web image becomes a focusable “View picture” control and Enter opens the new lightbox. I reproduced this using the real editor and synthetic image pixels; Add File and resizing were absent. Thus “no user-visible change while off” is false.  
   **Fix:** preserve the previous image rendering and interaction while the gate is off, including existing HTTPS images. Test gate-off behavior against the pre-B3 editor.

3. **R2-3 — should fix — Failed background retries produce unhandled promise rejections.** [attachment-cache.ts:355](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:355)  
   With repeated injected marker-write failures, the scheduled retry emits an unhandled `QuotaExceededError`: the returned `enqueue(...).then(...)` promise has no rejection handler. The background sweep has the same omission. Recovery eventually succeeds when storage works again, so this is not an observed deadlock.  
   **Fix:** handle rejection on every fire-and-forget cleanup promise while retaining pending state and retry scheduling; assert that repeated failures emit no unhandled rejection.

4. **R2-4 — blocking for gate enablement only — F4 remains unresolved and correctly documented.** [notes-attachments-implementation.md:140](/srv/presidium/projects/palladian/code/.worktrees/attachments/docs/reviews/notes-attachments-implementation.md:140)  
   Copies still lack `sourceNoteIds`; the unchanged backend searches only 48 reference rows per change. The round-1 49-attachment failure therefore remains relevant.  
   **Fix:** approve, implement and independently review the proposed provenance path before enabling files. The revised proposal correctly covers acknowledgement, retries, journal reload, rebasing and splitting batches with more than three sources. This remains a fundamentals integration requirement.

**F1, F3 and F5–F8 passed their targeted regressions.** Route coverage now includes revocation on all three pages; I additionally checked account switches on Invite and Reset. Late reads, acknowledgement without a reference, late admission cancellation and keyboard activation passed. Successful-marker recovery and stale-write fencing also passed. I found no new cross-account read bypass or permanent refusal after storage recovered.

**B3 is not accepted for gate-off release** because of R2-1 and R2-2. Upload entry-point tests passed; no gate-off upload write was observed.

Validation performed:

- **Typecheck:** passed.
- **Unit tests:** 20 session tests and 329 Vitest tests passed; includes mocked services and fake IndexedDB.
- **Local Chromium suite:** 180 passed, 20 skipped across desktop and mobile emulation. Includes attachments, A3 editor, files gate, actions, pins, notebooks and fixture History coverage.
- **Additional browser probes:** real IndexedDB, real editor and real SessionController with synthetic data, scripted services and injected failures. Covered marker failure/reopen, repeated-failure recovery, initial memory-only fallback, stale writes across separate browsing contexts, Invite/Reset account switches, delayed read after sign-out, and gate-off image activation.
- **Static review:** specified fundamentals unchanged; F4 proposal checked against backend limits. No additional regression identified in Duplicate or History, but their real-service flows were not rerun.
- **Not run:** dev-service e2e at 5178, a new convex-test reproduction of F4, Worker/R2 integration, actual quota exhaustion, WebKit/Safari private browsing, assistive technology or a real iPhone.

No production contact, commits, pushes or deployments. Worktree remains clean.
