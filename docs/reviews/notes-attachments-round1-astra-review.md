# Inline attachments — independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `8e7088a..85a42c7` on `feat/notes-attachments`. Report recorded verbatim below; responses are in `notes-attachments-implementation.md`.

---

CHANGES NEEDED

1. **F1 — blocking — Cache cleanup does not cover every session-owning page.** [App.tsx:382](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/App.tsx:382)  
   The cleanup subscriptions exist only inside `App`. `/connect`, `/invite` and `/reset` start sessions without mounting it. I cached synthetic bytes, navigated to `/connect`, and triggered fixture revocation: the session became `revoked`, but the bytes remained in IndexedDB. Account switching through these pages has the same coverage gap.  
   **Fix:** install shared attachment-cache lifecycle handling on every session-owning page, or propose a separately reviewed bootstrap integration. Add route-specific revocation and account-switch tests.

2. **F2 — blocking — Failed/interrupted clears can leave readable, unaccounted-for bytes.** [attachment-cache.ts:80](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:80)  
   `retain` and `forget` delete metadata and bytes in separate transactions. Cleanup failures are swallowed by App, with no durable pending-clear marker or retry. Injecting an interruption between the deletions left **zero metadata entries but readable old bytes** after reopening and retaining the same account. Those bytes also escape size accounting and eviction. The sign-out hint does not prove attachment cleanup finished.  
   **Fix:** make metadata/byte deletion atomic, persist cleanup intent and lifecycle fencing, and complete pending cleanup before permitting reads for a reactivated account. Test interrupted clears and stale writes from another tab.

3. **F3 — blocking — Late reads bypass subsequent invalidation or sign-out.** [editor-attachments.ts:466](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:466)  
   Availability is checked before awaiting bytes, but not afterward. `setKnown` does not invalidate the pending load attempt. I held a read, removed the object from the authoritative list, then completed the response: **`unavailable` became `shown`, and bytes were cached again**. Separately, completing a file read after `destroy()` and sign-out still initiated its download.  
   **Fix:** fence reads and downloads by runtime lifetime, account lifecycle and object availability. Invalidate/abort pending work on destruction or denial; recheck before caching, rendering or downloading. Close affected lightboxes too.

4. **F4 — blocking for enabling B3 — Missing source provenance silently loses usable copied attachments.** [editor.tsx:803](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor.tsx:803), [proposal:130](/srv/presidium/projects/palladian/code/.worktrees/attachments/docs/reviews/notes-attachments-implementation.md:130)  
   This affects ordinary multi-file copies, not only unusually popular objects. The search budget is **48 reference rows per entire change**. My convex-test probe copied 49 attachments from a readable shared note, each with one source reference: only 48 were proven. Naming the source proved all 49. The remaining document node grants no access and keeps no object alive.  
   **Fix:** implement the proposed provenance path through clipboard → transaction → journal/channel → `sourceNoteIds`, with independent protected-core review. The proposal is directionally correct, but must preserve provenance through acknowledgement, retries, reload and rebasing, and handle more than three accumulated source notes without silently discarding required sources. This is a **fundamentals integration gap**, not an identified defect in the unchanged core. Shipping enabled B3 without it is not acceptable under the B1 copy contract.

5. **F5 — should fix — Remote images can remain “Loading…” indefinitely.** [editor-attachments.ts:442](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:442)  
   When an image arrives while `known` excludes it, `watch()` sets unavailable without recording `wanted = true`. When the reference list subsequently includes it, `setKnown()` changes it to `idle` rather than loading. I reproduced **`unavailable → idle`, with zero byte requests**, using a remote insertion followed by its reference-list update.  
   **Fix:** record byte demand independently of current availability, then load when availability becomes valid.

6. **F6 — should fix — Acknowledgement does not reconcile provisional attachment visibility.** [editor-attachments.ts:331](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:331)  
   The plugin has no update hook to reconsider `unsentObjects`. Paste a cached attachment while `known` is empty: unsent steps temporarily permit display. Acknowledge those steps without granting a reference, and the image stays shown because the unchanged empty query result need not trigger another callback. I reproduced this. Without cached bytes, deferred loading can likewise remain unresolved.  
   **Fix:** reconcile attachment records when the relevant document or unconfirmed-step state changes, including acknowledgement.

7. **F7 — should fix — A timed-out admission loses its eventual cancellation target.** [attachments.ts:257](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachments.ts:257)  
   `withTimeout` discards a late successful `createUpload` result. If the user presses Remove after timeout, the task still has no object ID. My delayed-mutation probe returned its grant afterward and observed **zero cancellation calls**. The pending object survives until server cleanup and consumes admission capacity.  
   **Fix:** retain ownership of the original admission promise and clean up late grants for abandoned tasks, using the originating account/service. Preserve the request ID for genuine retries.

8. **F8 — should fix — Opening attachments is pointer-only.** [attachment-views.ts:129](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-views.ts:129), [attachment-views.ts:433](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-views.ts:433)  
   Images and chips have no focusable activation control or keyboard open handler. Editable activation additionally depends on `pointerdown` setting `pressedSelected`. A keyboard-only user cannot open the lightbox or download a chip; resizing also has no accessible alternative.  
   **Fix:** provide keyboard activation and semantic controls while preserving first-tap selection, plus accessible resize/reset actions.

The R5-2 test change is **not weakened**: the selectors target the new node views, the wait ensures the intended caret transition, and the added title assertion is stronger. It passed on desktop and mobile Chromium.

Validation performed:

- **Typecheck:** passed.
- **Unit tests:** 20 session tests and 321 Vitest tests passed; includes mocked services and fake IndexedDB.
- **Local Chromium suite:** 153 passed, 20 skipped, one notebook draft-test failure. That test passed all three targeted reruns; the initial failure remains unexplained.
- **Local browser probes:** reproduced F1–F3 and F5–F7 using real IndexedDB/editor code with synthetic sessions, mocked responses and injected failures.
- **convex-test:** reproduced the 49-object source-proof failure and successful named-source control; no remote deployment used.
- **Static review:** verified the specified fundamentals files are unchanged. Header-only authentication and ordinary blob-URL revocation paths looked correct.
- **Not run:** real-service attachment/actions/live/history e2e, actual Worker/R2 upload completion, real quota exhaustion, WebKit, assistive technology or a real iPhone.

No production contact, commits, pushes or deployments. The working tree remains clean. Gate-off alone does not address the cache and read-lifecycle findings.
