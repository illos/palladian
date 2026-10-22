# Note actions — independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `f59008e..8eff3f0` on `feat/notes-note-actions`. Report recorded verbatim below; responses are in `notes-note-actions-implementation.md`.

---

CHANGES NEEDED

1. **F1 — blocking: Duplicate, Export and Print use stale open-note content.**  
   [App.tsx:765](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:765) returns `openRef.current.document`, which is the opening snapshot. Bound editor transactions do not update it ([editor.tsx:481](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/editor.tsx:481)). Local browser probe: editor contained **“Alpha changed”**, but Duplicate submitted **“Alpha”**. Newly created notes can consequently duplicate their initial empty document. Info counts have the same problem. **Fix:** obtain a current editor snapshot for these actions, including pending edits.

2. **F2 — blocking safety gap, inherited: Trash can discard unjournaled typing.**  
   [App.tsx:833](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:833) closes the editor after Trash without settling pending work. A `trashed` channel error blocks journaling; [channel.ts:349](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/channel.ts:349) then skips the write. A local probe injecting that error before the 200 ms journal deadline and completing Trash left **no editor, no journal, and only the old accepted text**. This vulnerability also exists in the base implementation; it is not a new channel regression. **Fix:** durably preserve or settle current typing and prevent further edits before completing the lifecycle transition. Review any required protected-core change separately.

3. **F3 — should fix: delayed lifecycle completion closes another note.**  
   `shown` is captured before awaiting ([App.tsx:784](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:784)); Trash and Delete subsequently call `closeOpen()` using that stale decision. Reproduced: start trashing Alpha, open Beta, resolve Alpha’s request—Beta disappears. This carries forward the old toolbar race into the new action handler. **Fix:** recheck the current note identity and operation/session generation after awaiting; close only the matching current instance.

4. **F4 — should fix: open menus retain obsolete permissions and connectivity.**  
   [App.tsx:761](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/App.tsx:761) stores action availability as a snapshot, and `runAction` does not revalidate it. Reproduced an owner→reader update while the menu remained open: Move and Trash stayed visible, and selecting Trash invoked the mutation. Offline transitions have the same omission. The server remains the authorization boundary; this is not a demonstrated server bypass. **Fix:** recompute or dismiss menus when their target changes, and validate current account, role, lifecycle and connectivity before execution.

5. **F5 — should fix: touch interactions break subsequent keyboard actions.**  
   [SwipeRow.tsx:109](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:109) consumes keyboard clicks when `swallowClick` remains set; only pointer-down resets it. Reproduced long press → Cancel → focus row → Enter: the first Enter does nothing, the second selects. Additionally, [SwipeRow.tsx:167](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:167) rejects Shift+F10 after touch because `lastPointer` still equals `"touch"`. **Fix:** scope suppression to the originating pointer gesture and handle keyboard context-menu invocation independently.

6. **F6 — should fix: swipe state does not reconcile changed actions or expired velocity.**  
   [SwipeRow.tsx:83](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:83) resets only when `open` changes. Reproduced connectivity loss leaving the row translated **−152 px with zero action buttons**. Separately, release uses the last movement velocity without aging it ([SwipeRow.tsx:228](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/SwipeRow.tsx:228)): a **40 px drag held stationary for one second** still opened the row. **Fix:** reconcile offsets when layouts change and expire velocity after stationary time.

7. **F7 — note: print validation failures leak the iframe.**  
   [note-tools.ts:71](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/src/note-tools.ts:71) appends the frame before parsing, while cleanup is registered afterward. A local unsafe-link probe correctly rejected `javascript:` but left one iframe behind. Schema validation and DOM serialization otherwise preserve the editor’s content restrictions. **Fix:** validate before appending and remove the frame on construction/serialization failure.

8. **F8 — should fix: automated coverage misses the decisive cases above.**  
   [note-actions.test.ts:16](/srv/presidium/projects/palladian/code/.worktrees/note-actions/apps/notes/tests/unit/note-actions.test.ts:16) checks static action lists; browser action tests use stalled-session fixtures. The service script duplicates an untouched note and covers owner happy paths, not edited-content copying, role changes, delayed responses, pending typing, mixed-ownership Empty Trash or partial failures. Its pause also does not neutralize the stale velocity identified above. **Fix:** add targeted regressions for these cases and genuine touch taps following sheet opening; Chromium emulation does not establish iOS correctness.

Passed locally: 20 session tests, 106 Vitest tests, typechecking, 56 Chromium browser tests (8 skipped), and 2 production-build offline tests. Additional probes used Chromium with local mocks. No services, deployments, WebKit or real iPhone were exercised. Duplicate’s creation payload excludes history/sharing/public-link metadata; Empty Trash filters owners and reports partial failures. The worktree remains clean.
