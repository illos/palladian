# Note history — independent review, round 7

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `6e1b50d..6eb2038` on `feat/notes-history`, after the round 6 responses. Report recorded verbatim below; responses are in `notes-history-implementation.md`.

---

CHANGES NEEDED

1. **R7-1 — should fix: completion checks can become stale across the final await.** [in-session.ts:25](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/in-session.ts:25), [App.tsx:1182](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1182), [App.tsx:1434](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1434). A → B can occur after `inSession` computes `current: true` but before App resumes. Extracted-callback probes reproduced both success toasts appearing under B; Restore also calls `setDialog(null)`. Duplicate’s failure can similarly escape `failInSession` into the unfenced outer error handler. **Fix:** recheck the ticket synchronously at the final success/error UI operation, after every intervening await.

2. **R7-2 — should fix: Open remains callable after switching accounts.** [App.tsx:1438](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1438), also [App.tsx:1185](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1185). Let A’s copy finish, switch to B before the toast expires, then press Open. Both callbacks invoke the captured `openRemote` without checking the initiating session. Independently reproduced with an Open spy. **Fix:** check `current()` inside each Open callback. This fix belongs at these callers; it requires no change to the protected `openRemote`.

3. **R7-3 — note: retry protection has a client-lifetime boundary.** [copy-keys.ts:38](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/copy-keys.ts:38). The actual Convex client’s `close()` leaves pending mutation promises unresolved. If App survives client replacement, the operation stays “sending” indefinitely; a full reload instead loses the in-memory key. **Fix:** explicitly document/test this boundary. If client replacement is supported, retain the key but release the sending state when its client is retired, fencing late completions. I found no normal client-close/replacement path in the current app, so this is not a demonstrated release blocker.

R6-1’s **cross-account creation** defect is fixed; its UI isolation remains incomplete above. R6-2 passes the applied-but-unacknowledged/reopen/retry probe within one App lifetime. R6-3’s stronger assertions and R6-4’s specification correction are present.

The optional `account` check grants nothing, precedes replay, and accepts the same account across separate sessions. Drafts, conflict copies and older clients omit it and retain existing behavior; MCP creation uses `createFromMarkdown`. Agent probes passed. Clearing keys for application errors with `data.code` is sound: a thrown mutation `ConvexError` prevents that transaction committing. Other errors conservatively retain the key. [Convex documentation](https://docs.convex.dev/functions/error-handling/application-errors)

No additional A6/A3/B1+B2 regression or release blocker found.

Validation run:

- Frontend and backend typechecks passed.
- 20 Node tests, 268 frontend tests, 190 backend tests passed.
- 19 independent local probes passed, including assertions reproducing the findings: extracted App callbacks, actual helpers, `convex-test`, mocked timing, and actual Convex client with a fake socket.
- Local Chromium: 104 passed, 18 skipped; offline browser tests: 2 passed. Service endpoints were disabled.
- Actual-service history/actions/live/arrange e2e, WebKit and real iPhone checks **not run**.

No production contact, commits, pushes or deployments. Tracked worktree remains clean.
