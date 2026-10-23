# Note history — independent review, round 9

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `6e1b50d..e01ce4b` on `feat/notes-history`, after the round 8 responses. Report recorded verbatim below; responses are in `notes-history-implementation.md`.

---

ACCEPTED

1. **R9-1 — note: the initial stale-session exit can display a toast.** [copy-keys.ts:188](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/copy-keys.ts:188). Retain A’s Restore callback, switch to B, then invoke it: `!current()` calls `failed`, displaying “Connection unavailable” in B’s session. No write occurs. Reproduced with extracted App callbacks and browser controls; **no ordinary UI path to this stale invocation was found**, so this is nonblocking. **Fix:** return silently when `!copy.current()`; report disconnection only while the ticket remains current.

**R8-1 is resolved.** Probes verified reopened-panel refusals, closed-panel toasts, two-panel bookkeeping, rapid opening/closing, StrictMode cleanup, and pending refusals after A → B showing nothing to B. Success closes reopened History for the same note, preserves another note’s dialog, and fences Open. Notices remain scoped to account, note and revision.

Retry keys survive unanswered attempts and are dropped after success or application refusal. Restore still sends `sourceNoteId`; files-off behavior passes. Copies match the historical document exactly and leave the original unchanged. Duplicate retains its behavior with session fencing. No additional release blocker found in `6e1b50d..e01ce4b`; protected fundamentals are unchanged.

Validation run:

- Frontend/backend typechecks passed.
- 20 Node and 280 frontend Vitest tests passed. Initial parallel run had one existing session-readiness failure; isolated and full four-worker reruns passed.
- 190 backend tests passed using **convex-test**.
- 40 independent probes passed using extracted App callbacks, mocked timing and convex-test.
- Local Chromium: **104 passed, 18 skipped**. Additional browser probes exercised actual extracted controls under StrictMode with mocked mutation responses.
- Two offline Chromium tests passed using a production build and real service worker.
- Actual-service e2e, WebKit and real iPhone checks **not run**. Local browser services were Vite only; service endpoints were disabled.

No production contact, commits, pushes or deployments. Tracked worktree remains clean at the requested head.
