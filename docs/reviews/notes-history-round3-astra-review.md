# Note history (A4) — round 3 independent review

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `b095f8c..f623a93` on `feat/notes-history`.

---

1. **R3-1 — blocking: Reopening bypasses an unresolved restore.** [App.tsx:1303] locks only openings preceding the request; [show():559] increments that counter. After 20 seconds, close History, switch notes and return: editing resumes while Restore remains pending. A local probe using the actual predicate and `NoteChannel` confirmed that subsequent unsent text and its journal disappear when the replacement arrives. Reload also loses the in-memory operation record. An unanswered request otherwise keeps History busy indefinitely. **Fix:** retain an account/note-scoped hold across openings, persist and reconcile unresolved requests across reload, and provide recovery without silently unlocking editing. Extend the regression beyond the unchanged opening currently tested at [history-e2e.mjs:640].

2. **R3-2 — blocking: The target probe verifies identity, not deployment type.** [dev-target.mjs:107] extracts only a dashboard name; line 151 compares that name. The installed CLI produces the same dashboard URL format for dev and prod. A local, network-free probe of its credential-resolution code accepted a mocked `prod` response for a selection configured as `dev:<name>`; that response passed this name check. **Fix:** require authoritative deployment metadata reporting `deploymentType === "dev"`, matching name and URLs. The inspected named-deployment dashboard path performs access/credential authorization requests; it does **not** deploy or provision a deployment.

3. **R3-3 — should fix: Redaction still has gaps.** Local canaries survived a second cookie value, a relative opaque URL path, and `Error.name`. The cookie pattern stops at semicolons, path scrubbing requires an absolute URL, and the failure name bypasses redaction ([redact.mjs:44], [redact.mjs:61]). Debug callbacks explicitly pass relative paths ([history-e2e.mjs:178]). **Fix:** redact complete cookie headers, normalize relative URLs, and sanitize the complete formatted failure. Add these canaries.

4. **R3-4 — should fix: The actions e2e remains incompatible after merging current main.** [actions-e2e.mjs:189] asserts the complete menu. Commit `9976b59` adds Pin, but still omits History, which [note-actions.ts:107] now supplies. **Fix:** incorporate main's test changes and add History after Share.

5. **R3-5 — note: The editor wiring and unchanged-opening hold are sound by inspection.** Retain this wiring and add local lifecycle coverage while fixing R3-1.
