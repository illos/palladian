# Note history (A4) — round 2 independent review

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `5211e06..36f9dff` on `feat/notes-history`.

---

1. **R2-1 — blocking: Restore can still discard new typing in the restoring window.** The guard runs before dispatch, but Done, Escape and backdrop dismissal remain enabled during the request ([HistoryPanel.tsx:113], [HistoryPanel.tsx:452]). Hold Restore in flight, dismiss History, type with the push held, then release Restore: the new typing is unprotected. A local probe using the actual `NoteChannel` and mocked transport/store confirmed that replacement drops the pending step and clears its journal. **Fix:** retain an operation-level editing guard until the restore outcome is resolved, surviving panel dismissal and selection changes; add this deterministic scenario to the e2e.

2. **R2-2 — blocking: The e2e does not enforce development-only targeting.** Its preflight checks only `CONVEX_DEPLOYMENT`'s prefix and URL presence; provisioning inherits the environment, while HTTP calls use independently supplied URLs ([history-e2e.mjs:40]). A synthetic local probe passed with mismatched production-shaped URLs and a production-shaped deploy key. The installed Convex CLI gives deployment keys precedence over `CONVEX_DEPLOYMENT`. The browser app's configured endpoints are also unverified. **Fix:** validate the effective CLI target, HTTP endpoints and actual app endpoints against one verified development deployment; reject conflicting deployment overrides before provisioning.

3. **R2-3 — should fix: Failure logs can expose invitation tokens.** Account setup navigates to a token-bearing URL, and the script rethrows raw failures ([history-e2e.mjs:181], [history-e2e.mjs:816]). A local Chromium navigation failure included a synthetic invitation fragment in its error. Debug logging also forwards arbitrary console/error text verbatim. **Fix:** sanitize failures and debug output centrally; emit safe diagnostic fields instead of raw exceptions. Add canary tests for URL fragments, passwords and tokens.

4. **R2-4 — note: The documented fundamentals limitation is accurate, including already-journaled work in another tab.** The hold reads this window's cached rows ([App.tsx:1096]); ordinary cache notifications are instance-local ([cache.ts:294]). A two-store local probe found one durable pending step while the restoring tab received zero notifications and allowed Restore. **Fix:** keep the guarantee explicitly window-scoped, add a same-origin tab regression, and retain the separately reviewed preservation follow-up.

F2–F4 look correct; no additional A2 regression found.
