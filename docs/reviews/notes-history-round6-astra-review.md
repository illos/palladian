# Note history — independent review, round 6

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `6e1b50d..7a4c492` on `feat/notes-history`, a final pass after History switched to "Restore as a new note". Report recorded verbatim below; responses are in `notes-history-implementation.md`.

---

CHANGES NEEDED

1. **R6-1 — blocking: copy dispatch can cross accounts.** [App.tsx:1362](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/App.tsx:1362) checks connectivity before awaiting the import, then uses the shared client without rechecking account/session identity. A local probe using the extracted callback, actual `duplicateNote`, and `convex-test` switched A → B during that await: A’s copy committed with B as creator. Completion also updated the current dialog/toast. **Fix:** bind dispatch to the initiating account/session, recheck after asynchronous preparation, prevent queued writes crossing authentication changes, and fence completion UI. Add this regression.

2. **R6-2 — should fix: retries across panel lifetimes lose idempotency.** Busy state belongs to the selected version at [HistoryPanel.tsx:460](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/HistoryPanel.tsx:460); dismissal and selection changes remain available. Reopening or retrying invokes [note-tools.ts:26](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/src/note-tools.ts:26), generating another key. A local applied-but-unacknowledged-result probe followed by reinvocation created two copies. Ordinary double-click protection and Convex’s retries within one request are separate and remain intact. **Fix:** retain one creation key and pending outcome per copy operation across dismissal/retry; reconcile uncertain outcomes before issuing another key. This needs no editing hold on the original.

3. **R6-3 — note: strengthen the unsent-word proof.** [history-e2e.mjs:680](/srv/presidium/projects/palladian/code/.worktrees/history/apps/notes/scripts/history-e2e.mjs:680) installs the push gate, checks “Saving…”, then checks `word2` survives and eventually syncs. That exercises the intended scenario, but never asserts the gate captured a push or that server content lacked `word2` before release. **Fix:** assert both, including server absence after copying and before releasing the gate. The test currently verifies text fragments rather than exact copied-document equality; add that assertion too.

4. **R6-4 — note: the A4 specification still instructs in-place restore.** [08-deltos-feature-port.md:271](/srv/presidium/projects/palladian/code/.worktrees/history/docs/specs/notes-app/08-deltos-feature-port.md:271) still specifies `history.restore`, contradicting its updated introduction and implementation report. **Fix:** replace that bullet and its acceptance criterion with the new-note contract.

Removal is clean in the reviewed tree; backend, packages, channel and copy helper match `main`. Local probes confirmed destination authorization/default placement, reader history denial, revoked-agent refusal, historical attachment proofs, files-off rejection, exact copied content, and unchanged original content/revision. No additional A2/A6/A3/B1+B2 regression found.

Validation passed: 20 Node tests, 255 frontend tests, 186 backend tests, frontend typecheck, 104 Chromium tests (18 skipped), two offline tests, and four external local probes. No deployments or actual services contacted; service e2e, WebKit and real iPhone checks were not run. Tracked worktree remains clean.
