# Note actions — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed the round-2 fixes `ce30705..476b81d` on `feat/notes-note-actions`. Report recorded verbatim below; responses are in `notes-note-actions-implementation.md`.

---

CHANGES NEEDED

1. **R3-1 — should fix: cancellation before axis lock still leaves an obsolete swipe offset.**  
   The width effect skips active gestures at [SwipeRow.tsx:91](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:91), but cancellation reconciles only `axis === "x"` at [line 270](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:270). Local Chromium reproduction: rest open on Move/Share → pointer-down → lose connectivity → cancel before moving. The row remains translated **−152 px with zero buttons**. Cancellation after horizontal axis lock now passes. **Fix:** reconcile offsets on every gesture exit, including cancellation before axis lock and vertical-scroll exits, using current widths/open state. Add this regression.

2. **R3-2 — note: controlled regression tests do not require protected wiring changes.**  
   The explanation at [implementation report:66](/srv/presidium/projects/palladian/code/.worktrees/note-actions/docs/reviews/notes-note-actions-implementation.md:66) is insufficient. [App.tsx:169](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:169) already accepts `session`, `store`, and `liveBox`. My temporary Playwright harness mounted the unchanged App with real IndexedDB and mocked services, held transport/lifecycle responses pending, and delivered reader updates. **Fix:** add a test-only entry or intercept the entry module in Playwright; preserve production `main.tsx`. Cover delayed completion, pending journals, reader updates, and mixed-ownership/partial-failure Empty Trash.

The other fixes passed targeted local probes:

- **R2-1:** current-row permissions and Trash changes update toolbar actions and invalidate menus ([App.tsx:1032](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:1032)).
- **R2-2:** a server note actually journaled in IndexedDB retains row actions with transport held pending ([App.tsx:758](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:758)).
- **R2-3:** delayed Restore does not alter a reopened instance ([App.tsx:920](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:920)); Delete uses the same opening fence.
- **R2-4:** Info receives the updated reader document’s text ([App.tsx:795](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:795)); the probe stubbed the receiving panel.

Passed: **20 session tests, 107 unit tests, typecheck, 56 Chromium browser tests (8 skipped), and 2 production-build offline tests**. Browser tests used port 5197 after repeated 5178 contention, with unchanged tests and a temporary external configuration. No additional regression surfaced in selection, deep links, Settings, offline use, or drafts.

No actual services, production, WebKit, or real iPhone exercised. Worktree remains clean at `476b81d`.
