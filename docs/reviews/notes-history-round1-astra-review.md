# Note history (A4) — round 1 independent review

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `ce30705..378072e` on `feat/notes-history`.

---

CHANGES NEEDED

1. **F1 — blocking: Restore silently discards unconfirmed typing.** [HistoryPanel.tsx:423] restores without protecting pending edits. The existing backend generates a whole-document replacement ([history.ts:143]). A local reproduction using the actual `NoteChannel` and a mocked transport/store changed `Hello UNSAVED world` into `Old version`, reduced pending steps from one to zero, and cleared the journal. `expectedRevision` protects committed changes, not unsent typing. The e2e asserts text added **after** restoration, but never checks its concurrent `wordN` inputs ([history-e2e.mjs:355]). **Fix:** preserve unconfirmed work before applying a destructive restore, with recoverable conflict handling where rebasing cannot preserve it. Independently review that sync change. Add deterministic tests holding an editor's push until after restore, asserting both visible and journaled work survive.

2. **F2 — should fix: History remains available after connectivity is lost.** The new panel uses `liveReady` ([App.tsx:1697]), which checks authentication readiness, not connectivity ([App.tsx:256]). Connection loss only updates `connected` ([live.ts:138]). A local predicate probe confirmed History remains offered with `ready: true, connected: false`. The new browser tests cover startup without a live connection, not disconnection after authentication. **Fix:** gate History availability and restore interaction on connectivity separately from session readiness. Test disconnecting an authenticated client with History open.

3. **F3 — should fix: A pending journal can incorrectly close History opened from a row.** [App.tsx:1042] retains the action's source. For `"row"`, `currentTarget` prefers the row, whose `kind: "draft"` becomes `local: true`. Overriding role and Trash state does not correct that flag. A local probe produced `historyStale: true` for the row source and `false` for the open-note source, with identical note identity and permissions. **Fix:** distinguish server-backed pending journals from genuinely local drafts when determining History eligibility, independently of its launch source. Test a row-launched panel across a delayed journal write.

4. **F4 — note: Paging temporarily omits boundary versions during refresh.** [HistoryPanel.tsx:174] retains an old page while its new cursor loads. In a synthetic two-page example, adding revision 61 changes page one to `61…32`, while retained page two remains `30…1`: revision 31 disappears until refresh completes. Settled pages were consecutive and duplicate-free. **Fix:** show a loading state for mismatched cursors or update the displayed page chain coherently. Add a paging test with new versions arriving; the existing e2e pages a static list.

Validation passed: 20 Node tests, 128 Vitest tests, typecheck, 62 Chromium browser tests with 8 skips, and both offline tests. No new authorization bypass or unsafe rendering path found by inspection. Restore revision/conflict handling and retry-ID reuse within a mounted selection are sound.
