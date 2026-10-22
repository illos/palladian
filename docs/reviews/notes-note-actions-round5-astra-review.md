# Note actions — independent review, round 5

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed the round-4 fixes `c7fe1b0..dec6c79` on `feat/notes-note-actions`. Report recorded verbatim below; responses are in `notes-note-actions-implementation.md`.

---

ACCEPTED — ready to merge. No correctness regression found in `c7fe1b0..dec6c79`.

1. **R5-1 — note: R4-1 and R4-2 are resolved.**  
   [Reconciliation](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:120) and [cancellation](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:284) respect external closure. [Pointer-down suppression](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:212) prevents selection after actions disappear. Local touch probes confirmed keyboard and revealed-action clicks still work. After external closure, deliberate flick/drag opening correctly reclaims ownership; flick closing and full-swipe Trash preserve B’s ownership. **Fix: none required.**

2. **R5-2 — note: the harness is excluded from production.**  
   The [separate harness entry](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/harness/swipe.html:11) is outside the production entry graph. A fresh temporary production build contained only `index.html` as HTML, no harness files/code markers, and no harness service-worker entries. [Cache generation](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/offline-plugin.ts:23) uses emitted build assets. Both production offline tests passed. **Fix: none required.**

3. **R5-3 — note: the regressions detect the claimed failures.**  
   [The new tests](/srv/presidium/projects/palladian/code/.worktrees/note-actions/tests/browser/notes-swipe.spec.ts:83) pass on `dec6c79`. Substituting `c7fe1b0`’s component through a temporary Vite loader reproduced both failures: unexpected `A:select`, and cancellation retaining −152 px. Nine additional probes passed. **Suggested follow-up:** retain the external-close flick/full-swipe and revealed-action cases from [the temporary probes](/tmp/notes-r5-review-tdwmf51_/probe.spec.ts:83).

Passed: **20 session tests, 107 unit tests, typecheck, 59 browser tests (11 skipped), nine additional touch probes, production build, and two offline tests**. Browser checks used local fixtures/controlled state; offline checks used the real service worker. No actual backend services, production, WebKit, or real iPhone exercised. iPhone validation and the previously deferred App-level regressions remain pending. Worktree unchanged.
