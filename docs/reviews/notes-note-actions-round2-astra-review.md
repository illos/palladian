# Note actions — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed the round-1 fixes `8eff3f0..ce30705` on `feat/notes-note-actions`. Report recorded verbatim below; responses are in `notes-note-actions-implementation.md`.

---

CHANGES NEEDED

1. **R2-1 — should fix: toolbar actions still use stale permissions and lifecycle state (F4).**  
   [App.tsx:1004](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:1004) retains the opening role and Trash state; [currentTarget:778](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:778) prefers these for toolbar actions. Local Chromium probe: owner→reader left Move and Trash visible, and selecting Trash invoked the mocked mutation. **Fix:** combine current row permissions/lifecycle with the open editor’s identity, and test both menu sources. This is a UI validation failure, not a demonstrated server authorization bypass.

2. **R2-2 — should fix: journaling a server note disables all its row actions.**  
   [App.tsx:749](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:749) treats every `kind: "draft"` summary as a local-only note, but [cache.ts:450](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/cache.ts:450) also assigns that kind to journaled server notes. Reproduced with real IndexedDB and pending transport: typing closed an existing seven-action row menu; right-click could no longer reopen it. **Fix:** distinguish unsent local notes from server notes with pending edits when constructing action targets. Preserve Export/Print and valid lifecycle actions.

3. **R2-3 — should fix: the “opening key” does not identify an opening (F3).**  
   [App.tsx:598](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:598) sets `key` to the saved note ID, reused on reopening; [Restore:898](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:898) therefore accepts an older completion. Local delayed-response probe: Restore Alpha → open Beta → Alpha is trashed again → reopen Alpha → resolve the old Restore changed its status from “In Trash” to “Saved,” despite the current row remaining trashed. **Fix:** fence completion with a per-opening request token and session generation. The different-note delayed Delete case now passes.

4. **R2-4 — should fix: reader-mode Info still uses opening text (F1).**  
   Reader updates replace `document` but not `text` at [App.tsx:409](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:409); [openContent:786](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:786) falls back to that stale text because readers have no channel. Reproduced: the editor displayed “Alpha changed with five words,” while Info reported **1 word, 5 characters**. **Fix:** derive fallback counts from the current document; add a reader-update regression.

5. **R2-5 — should fix: cancelling a gesture can restore an obsolete swipe offset (F6).**  
   The width effect skips active gestures at [SwipeRow.tsx:91](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:91), and cancellation restores `g.start` at [line 268](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:268). Local synthetic-pointer probe: open row → start another drag → remove connectivity → cancel left it translated **−76 px with zero buttons**. **Fix:** reconcile cancellation against current action widths and open state, including changes skipped during the gesture.

6. **R2-6 — note: F8 coverage remains incomplete.**  
   The new [service steps](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/scripts/actions-e2e.mjs:217) exercise useful happy paths, but do not deterministically hold edits pending or force Trash before the journal deadline. The menu regression covers a row, missing R2-1. **Fix:** add controlled transport/timer regressions for these findings, delayed lifecycle completion, and mixed-ownership/partial-failure Empty Trash.

Verified: `NoteChannel.current()` returns pending editor content without changing editor state or journal timing. Duplicate used it correctly. Scoped F2 passed an injected post-close `trashed` error; failed Trash preserved typing in IndexedDB and reopening recovered it. F5’s keyboard regression passed. Invalid print input left no iframe. The row-limit fix is sound.

Checks passed: **20 session tests, 106 unit tests, typecheck, 56 Chromium browser tests (8 skipped), and 2 production-build offline tests**. Additional probes used local mocks and Chromium, including real IndexedDB. No real services, production, WebKit, or iPhone were exercised. Worktree remains clean at `ce30705`.
