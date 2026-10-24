# File notes and the PDF reader — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-24. Reviewed `eacfafd..b06b53a` on `feat/notes-file-notes`, after the round 1 responses. Report recorded verbatim below; responses are in `notes-file-notes-implementation.md`.

---

ACCEPTED — **for release with files kept off**, at `b06b53a`. F1–F5 are resolved within the documented operation lifetime. No new release blocker found. This does **not** approve enabling files.

1. **R2-1 — note: retry recovery ends with the in-memory operation.**  
   [file-note-operations.ts:65](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/file-note-operations.ts:65), [file-note-operations.ts:185](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/file-note-operations.ts:185)  
   Remove discards the operation, not a server-side note. I reproduced Remove followed by a late server commit: one title-only note remained, with no navigation or upload. Reload likewise loses the file and creation key; re-adding afterward can create another note.  
   **Follow-up:** explicitly document that boundary and explain that Remove stops waiting. Durable retry recovery would require a separately designed persistence change. This is not a blocker for the scoped release.

2. **R2-2 — note: the existing navigation race remains.**  
   [App.tsx:749](/srv/presidium/projects/palladian/code/.worktrees/file-notes/apps/notes/src/App.tsx:749)  
   A held open for A can finish after B opens and reclaim navigation. The overlapping-drop regression confirms each file now reaches its own note, but does not resolve navigation intent.  
   **Fix:** a separately reviewed intent fence in `openRemote`, as already recorded under F6. The protected function is unchanged.

3. **R2-3 — blocking before enablement only: B3 provenance remains outstanding.**  
   [notes-attachments-implementation.md:148](/srv/presidium/projects/palladian/code/.worktrees/file-notes/docs/reviews/notes-attachments-implementation.md:148)  
   Copying attachments beyond the bounded reference-search budget can leave an attachment without proven access or retention.  
   **Fix:** implement and independently review source provenance through clipboard, journal, rebase and push, including the documented 49-attachment and multiple-source cases.

Verification of the requested fixes:

- **F1:** Worker-count regressions pass for successful open/close, unmount, malformed/encrypted input, abandonment during initialization, object invalidation, files-off, generation change and cache clear.
- **F2:** independent real-pdf.js probes at DPR 1–3 passed. A huge page displayed at 1,400px produced 1,400/2,000/2,000px canvases; a 72-unit page displayed at 600px produced 600/1,200/1,800px canvases. None exceeded four million pixels.
- **F3/F4:** lost-response Retry and re-add retain one key and one note; duplicate in-flight submissions are suppressed; overlapping held opens deliver both files correctly.
- **Operation fences:** account/generation scoping, sign-out cleanup and files-off suppression passed. Already-dispatched creation can still commit a title-only note. Releasing a held open after the actual 20-second deadline produced no upload; expired handles return `null`.
- **F5:** classifier equivalence passes across supported title blocks, including code blocks.
- **Harness:** uses the real App, cache, session, editor and channel paths with a stand-in Convex client. Its HTML and code are absent from the production build.
- **Regressions:** no regression found in B3, A3, History, Duplicate, actions, pins or notebooks. With files kept off, inspected behavior and regression coverage remain equivalent to main. All eight named fundamental files and four named App functions are byte-identical to main.

Before enabling files: complete R2-3; confirm every device runs B3+B4; complete the pending real-iPhone Safari/PWA checks for picker sources, uploads, reader interaction, selection and downloads. B3’s **R5-1 and R5-2 fixes pass this review**.

Validation I ran:

- Typecheck: **passed**.
- Session/unit tests: **20 + 339 passed**, using mocks/fake storage where applicable.
- Targeted backend tests: **69 passed** using local `convex-test`.
- Local Chromium suite: **270 passed, 22 skipped**, desktop and mobile emulation; real App/editor/pdf.js, mocked backend and file responses.
- Independent collaborative-browser probes: real local App and PDF engine, synthetic files and controlled service responses.
- Production build and offline service-worker tests: **passed; 2 offline tests passed**. Harness and QuickJS absent; PDF reader, Worker and data assets excluded from precaching.

**Not run:** remote dev-service e2e, real Worker/R2 integration, deployed CSP verification, WebKit/Safari, screen reader or real iPhone. No production contact, installs, source edits, commits, pushes or deployments. Worktree remains clean.
