# Note actions — independent review, round 4

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed the round-3 fix `476b81d..c7fe1b0` and the branch `f59008e..c7fe1b0` on `feat/notes-note-actions`. Report recorded verbatim below; responses are in `notes-note-actions-implementation.md`.

---

CHANGES NEEDED

1. **R4-1 — should fix: reconciliation ignores a parent close during the gesture.**  
   The [open effect](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:85) skips active gestures; [reconcile()](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:115) checks widths but not `open`. Controlled Chromium probe: open A → start another gesture → coordinator selects B → cancel, release without dragging, or exit vertically. **Both rows remain translated −152 px**, although B owns the open state. [Axis-locked cancellation](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:283) instead emits `onOpenChange(true)`, reclaiming ownership for A and closing B. The parent’s [conditional close callback](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:1336) is correct.  
   **Fix:** remember and honor external closure during a gesture; cancellation and non-drag exits must not restore that row or reclaim ownership. Add deterministic regressions.

2. **R4-2 — should fix: reconciling on pointer-up bypasses tap-to-close click suppression.**  
   [Pointer-up](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:254) reconciles a non-drag gesture without setting `swallowClick`. If actions disappeared, the offset becomes zero before [click capture](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:131). Real Chromium touch reproduction: open row → touch its front → remove actions → release. **The note’s selection handler fires.** With unchanged actions, the same tap only closes the row.  
   **Fix:** preserve whether the touch started on an open row and consume its resulting pointer click even if reconciliation already closed it. Preserve keyboard clicks and revealed-action clicks. Add this regression.

3. **R4-3 — note: the broader R3-2 harness can be deferred, but the swipe regressions should accompany these fixes.**  
   The [report](/srv/presidium/projects/palladian/code/.worktrees/note-actions/docs/reviews/notes-note-actions-implementation.md:76) defers even the changed gesture’s regression. My temporary harness mounted unchanged `SwipeRow` with controlled props; no backend or production-entry changes were needed. **Fix:** cover action removal/shrinkage across gesture exits, coordinator closure, and the resulting click before merge. The shared App harness can remain a separate task. Local App probes passed pending-journal actions, role updates, delayed Restore, reader Info, and mixed-ownership Empty Trash with partial failure.

The original obsolete-width case now passes across the tested exits. No additional correctness defect surfaced in the full-branch pass.

Passed: **20 session tests, 107 unit tests, typecheck, 56 Chromium browser tests (8 skipped), and 2 production-build offline tests**. Browser suites used an external config on port 5198. Additional probes used mocked services and real IndexedDB. No actual services, production, WebKit, or real iPhone exercised. Worktree remains clean at `c7fe1b0`.
