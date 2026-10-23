# Notebook management — independent review, round 7 (release candidate, Delete off)

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `b39fed7..e88e4a3` on `feat/notes-notebooks`, with Delete gated off by `NOTEBOOK_DELETE_ENABLED`. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

ACCEPTED — for release with Delete off. No new release blocker found in `b39fed7..e88e4a3`. This does not accept enabling Delete or resolve R3-1/R3-3.

1. **R7-1 — note: an already-open deletion dialog survives disabling the capability.**  
   **File:** [panels.tsx:1048](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/panels.tsx:1048), [App.tsx:2584](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/App.tsx:2584).  
   **Scenario:** Open the confirmation while enabled, then disable Delete. The menu disappears, but the dialog’s Delete button remains available. Submission is safely refused by the backend; this cannot arise in a deployment that stays off.  
   **Fix:** Close the idle deletion dialog or disable submission when the capability ceases to be true. Retain progress/error handling for an interrupted batch.

The server gate is sound: only exact `"true"` permits deletion, checked before notebook reads or writes on every call. I found no alternate MCP, agent, scheduled or internal notebook-deletion path. The scheduled cleanup only removes arrangement records. The capability exposes one boolean with bounded authentication reads.

The menu fails closed for false, unknown, loading and query-error results, and is unavailable when signed out. Enabling requires no client deploy: Convex invalidates subscriptions on environment-variable updates. Disabling stops subsequent batches safely; it does not undo completed batches. [Convex documentation](https://docs.convex.dev/deployment-api/update-environment-variables)

With Delete off, I found no additional defect in rename/description, other menu actions, NotebookNav, the repaired draft guards or owner fallback, and no regression to A2/A6/A3/B1+B2/A4.

Backend compatibility is preserved: one new table, three indexes on existing tables and the new table’s index; no existing fields, tables or indexes removed. All **95 existing registered function argument/return validators** are unchanged, including `notes.create`. No application data migration is required. Convex backfills indexes before completing deployment; production-scale duration remains unmeasured. [Deployment documentation](https://docs.convex.dev/cli/reference/deploy)

Validation I ran:

- App and backend typechecks: passed.
- App tests: **20 Node + 296 Vitest passed**; mocks/fake IndexedDB.
- Backend: **212 passed** using `convex-test`, including transaction-limit cases.
- Additional backend probe: disabling between batches causes no further writes; re-enabling completes; owner fallback still works after disabling.
- Additional capability-watcher probe: unknown, false, true, malformed response, error, recovery and unsubscribe all behaved correctly; mocked client, actual module.
- Local Chromium: **120 passed, 20 skipped**, desktop and phone emulation with fixtures.
- Offline: **2 passed**, local production build, real service worker, network disabled.
- Protected files and all four protected App functions unchanged; worktree clean at the requested head.

Not run: real-service E2E scripts, actual authentication/Convex/R2, production backfill, WebKit or a real iPhone. The notebook long-press iPhone check remains pending. No production contact, source edits, commits, pushes or deployments.
