# Note history — independent review, round 8

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `6e1b50d..2da7efe` on `feat/notes-history`, after the round 7 responses. Report recorded verbatim below; responses are in `notes-history-implementation.md`.

---

CHANGES NEEDED

1. **R8-1 — should fix: restoring can silently lose its failure after History is reopened.** [HistoryPanel.tsx:499](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/HistoryPanel.tsx:499), [App.tsx:1429](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1429). Start Restore, dismiss History, then reopen the same version while the request remains pending. If the server refuses creation, `failed` updates the unmounted panel. The reopened panel changes from “Creating…” to an enabled “Create note”, with no error or toast. The same session never sees why creation failed. Reproduced with extracted App callbacks and in Chromium using the production controls. **Fix:** retain the failure alongside the operation at App scope and deliver it to the current panel, or show a session-fenced fallback toast when the initiating panel has unmounted. Preserve the files-off message mapping.

2. **R8-2 — note, fundamentals: one client per page does not guarantee pending mutations settle across sign-out.** [copy-keys.ts:17](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/copy-keys.ts:17), [live.ts:173](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/live.ts:173). The lifetime claim is correct: I found one creation site and no replacement/close path. However, the installed Convex client can stop its socket after an authentication rejection while fetching a replacement token. `clearAuth()` does not settle pending mutations or restart that socket. I also reproduced signing back in before the old fetch completes: the new authentication configuration supersedes the old continuation without restarting the stopped socket, leaving the copy “sending” after both fetches settle. The app would remain without live readiness, hide History, and show “Connected — server unreachable”; no copy outcome appears. **Fix:** correct the unconditional guarantee in `copy-keys.ts` and track the auth/socket recovery defect separately in the fundamentals. This is not an A4 defect. Evidence uses the actual SDK with a fake socket, not a live authentication service.

**R7-1 and R7-2 are resolved.** Extracted-callback probes covered preparation, dispatch, successful completion and failure awaits, including microtask sweeps. No completion UI crossed into B. Open did nothing after A → B or A signing out and back in.

Restore still passes `sourceNoteId`; text-only copies work with files off. Lost-acknowledgement retries reuse the key and create no second note. Original content/revision remain unchanged, and the copied document matches exactly. Duplicate retains its prior behavior with session fencing. No additional release blocker found.

Validation run:

- Frontend/backend typechecks passed.
- 20 Node, 272 frontend and 190 backend tests passed; backend tests use `convex-test`.
- 38 independent local probes passed, including defect reproductions, mocked timing, extracted callbacks, `convex-test` and actual SDK/fake-socket checks.
- Local Chromium: **104 passed, 18 skipped**. Two additional panel probes and two offline tests passed. Service endpoints were disabled.
- Actual-service history/actions/live/arrange e2e, WebKit and real iPhone checks **not run**.

No production contact, commits, pushes or deployments. Tracked worktree remains clean at the requested head.
