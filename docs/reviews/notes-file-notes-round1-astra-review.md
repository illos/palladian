# File notes and the PDF reader — independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-24. Reviewed `eacfafd..944e990` on `feat/notes-file-notes`. Report recorded verbatim below; responses are in `notes-file-notes-implementation.md`.

---

CHANGES NEEDED

Reviewed `944e990` against `eacfafd`. **No new blocker found for release with files kept off. B4 is not accepted for enablement.**

1. **F1 — blocking before enablement: PDF Workers survive reader cleanup.**  
   [pdf-engine.ts:103](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/pdf-engine.ts:103), [pdf-engine.ts:226](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/pdf-engine.ts:226)  
   `PDFWorker.destroy()` does not terminate an externally supplied `port`. Three successful open/destroy cycles created three Workers and terminated none; a destroyed document’s Worker still answered a subsequent message. Closing the reader and rejecting an encrypted PDF also left Workers running. Additionally, unmount cannot cancel an `openPdf()` still awaiting initialization.  
   **Fix:** retain and explicitly terminate the native Worker, destroy the loading task on failure, and provide cancellation during initialization. Cover success, failure, close and every invalidation fence.

2. **F2 — should fix: the canvas cap uses the wrong scale.**  
   [pdf-engine.ts:200](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/pdf-engine.ts:200)  
   `cap` is calculated relative to the CSS viewport but used as an absolute PDF scale. At DPR 3, a 10,000×10,000-unit page fitted to 1,400px produced a **4,200×4,200 canvas: 17.64 million pixels**, exceeding the four-million cap. Conversely, a small page displayed at 1,152px received only a 250px bitmap.  
   **Fix:** use `scale * Math.min(devicePixelRatio, cap)`, or calculate the absolute cap from the scale-1 viewport. Verify both enlarged and reduced pages.

3. **F3 — should fix: creation retries do not retain their creation key.**  
   [App.tsx:2113](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/App.tsx:2113), [note-tools.ts:50](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/note-tools.ts:50)  
   After a mocked server commit followed by a lost response, reselecting the same file sent another `notes.create` with a different key. The first title-only note can therefore coexist with the retried note. There is no retained operation or pending-creation guard. B3’s upload-widget Retry correctly stays within the already-created note.  
   **Fix:** retain the file and client key for an unresolved creation, expose Retry for that operation, and prevent duplicate submissions until its outcome is known.

4. **F4 — should fix: overlapping creations silently discard a pending file.**  
   [App.tsx:2131](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/App.tsx:2131)  
   Drop `first.zip`, hold its open, then drop `second.zip`. The second result replaces the single `fileNoteUpload`. Releasing both opens uploaded only `second.zip`; `first.zip` remained title-only, with no failure notice. Replacing the state also cancels its timeout. This is separate from the existing `openRemote` race.  
   **Fix:** serialize creation/handoff, or track each pending operation independently. Superseding an operation must explicitly release its file and explain the outcome.

5. **F5 — note: editor and list classifiers disagree.**  
   [editor-file-notes.ts:44](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/editor-file-notes.ts:44)  
   A `code_block` title followed by one file qualifies in the editor because `isTextblock` is true, but fails the JSON classifier’s paragraph/heading restriction. Applying Mono to the title can therefore leave the large reader while removing its file-note list presentation.  
   **Fix:** align the allowed title types and test equivalence across every supported textblock.

6. **F6 — note, fundamentals issue: a delayed open can reclaim navigation.**  
   [App.tsx:737](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/App.tsx:737)  
   Create file note A, then open B while A’s `fetchContent` waits. A’s eventual `selectNote` can supersede B and start A’s pending upload. The handoff checks keep the file associated with A; they do not preserve the newer navigation intent.  
   **Fix:** address the existing `openRemote` intent fence through a separately reviewed fundamentals change. It remains unchanged here.

Validation performed:

- **Typecheck:** passed.
- **Session/unit tests:** **20 + 331 passed**; mocked services and simulated browser storage.
- **Local Chromium suite:** **244 passed, 20 skipped**, desktop and mobile emulation. Real editor and pdf.js; attachment services/network responses mocked.
- **R5-1/R5-2:** regressions passed, including removal→unknown, removal→restored, and admission A resolving after retry B landed. Source inspection confirms cancellation uses A’s originating service.
- **Independent browser probes:** reproduced F1–F5; verified offline/files-off drops send no creation, session changes suppress stale handoffs, and files-off between creation and upload leaves a title-only note. Verified the editor deadline with an accelerated timer.
- **Reader:** exercised a generated **1,500-page PDF**, bounded canvas virtualization, search navigation and visible highlighting. Generated encrypted input reached “Download to view”; malformed-input coverage passed.
- **Build/offline:** production build and **2 offline tests passed**. Reader, Worker and PDF data assets are excluded from precaching; QuickJS is absent. Startup JS measured **453.31 kB / 140.96 kB gzip**, approximately the documented 6.5 kB increase over main.
- **Inspection:** no scripting/annotation/XFA execution path or token-bearing DOM introduced; bytes use B3’s authenticated path. B3 test changes preserve assertions while substituting ZIP download fixtures. Named fundamentals and backend are unchanged.

**Not run:** real dev-service e2e, fresh convex-test, Worker/R2 integration, deployed CSP verification, WebKit/Safari, screen reader or real iPhone. Existing B3 provenance F4 and device requirements remain prerequisites for enablement.

No production contact, repository edits, commits, pushes or deployments. Worktree remains clean.
