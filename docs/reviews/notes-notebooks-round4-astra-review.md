# Notebook management — independent review, round 4

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `b39fed7..61d4b45` on `feat/notes-notebooks` (after the rebase onto `main` `b39fed7`), with R3-1/R3-3 excluded as awaiting the owner, and a design review of the proposed fundamentals change. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

CHANGES NEEDED

R3-1/R3-3 remain excluded as requested. I found one additional blocking access-control defect and one recovery regression.

1. **R4-1 — blocking: ownership evidence survives account switches.**  
   **Location:** [App.tsx:269](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/App.tsx:269), consumed at line 845.  
   **Scenario:** Account A views a notebook it owns. The same mounted app switches to B, whose cached draft targets that now-unavailable notebook. `listedNotebooks` still records A’s `"owner"` role, so B’s draft passes the guard without B’s deletion evidence. A local Chromium probe using the real session controller with mocked identity responses reproduced both the exposed title and readable editor content.  
   **Fix:** Scope ownership history by account and notebook, including writes and lookups. Likewise scope `draftTargets`. Add a switch regression with B’s pre-existing cached draft and no visible destination notebook.

2. **R4-2 — should fix: the destination guard incorrectly hides accessible conflict copies.**  
   **Location:** [notebook-actions.ts:118](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/notebook-actions.ts:118).  
   **Scenario:** A conflict copy has a local ID and its source’s notebook ID. The person retains direct access to the source note but cannot see its notebook. Existing cache reconciliation correctly preserves the copy through `source`; A5 nevertheless labels it unavailable and refuses opening it. Chromium reproduced this using `splitConflict` and `reconcileAccess`, with the copy readable and unfenced in the store.  
   **Fix:** Distinguish ordinary uncreated drafts from source-authorized conflict copies. Carry `source` through row and open-draft checks and preserve the existing source-access fencing. Test direct grants and source moves, including offline reopening.

The other requested checks passed:

- Ordinary unavailable drafts, including bare UUIDs, are redacted and blocked through list/deep-link opening and local search. Unknown ownership stays unavailable after reload/new-tab startup; mocked positive deletion evidence restores availability.
- `deletedByMe` protects other people’s deletions and unknown IDs. A 100-ID probe passed with transaction limits; 101 IDs were rejected.
- R3-5’s retained A6 integration test passes with transaction limits.
- Creation preserves **account → replay → source → destination/fallback** ordering.
- Notebook Trash retains B1 file synchronization; a targeted Trash/Restore probe verified object lifecycle changes.
- The CSS diff only appends A5 rules to main’s intact stylesheet. The existing Duplicate, History, editor, arrangement and file regression suites pass.

**Proposed fundamentals change — design assessment**

Reusing persistent holds, settlement filtering and BroadcastChannel notifications is the right minimal direction. The proposal is **not yet complete or safe to implement literally**. The following are findings against the proposal, not additional implemented A5 defects.

3. **R4-3 — blocking for the proposal: a negative deletion answer is not an access denial.**  
   **Location:** [implementation report:122](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:122).  
   **Scenario:** An older complete snapshot omits a newly created notebook, or access is restored between the snapshot and resolution. `deletedByMe` returns nothing because the notebook exists. “For any other answer, remove it” would purge legitimate work, potentially the owner’s own draft.  
   **Fix:** Purge only after a fresh, account-bound authoritative refusal. Distinguish writable destination, owner-deleted fallback and denied destination; retain replay/source authorization precedence. Treat lookup failures as unresolved.  
   **Proof needed:** Delayed snapshots, removal followed by re-sharing, owner creation racing a snapshot, lost creation replies, and successful owner fallback.

4. **R4-4 — blocking for the proposal: persisted-draft scanning misses memory-only work.**  
   **Location:** [implementation report:121](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:121); existing scan at [cache.ts:1407](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/cache.ts:1407).  
   **Scenario:** Another tab has a new draft whose first journal write is queued or failed because of quota. The reconciling tab finds no persisted draft ID, so it broadcasts no hold for that draft. Existing memory handling only expands already-identified IDs. The proposed change therefore does not establish that every exportable draft is fenced.  
   **Fix:** Cover queued and recovery-memory drafts, including those known only to another tab. Propagate account-scoped destination-access information so that tab can fence its own drafts. Preserve the owner’s latest journal while held.  
   **Proof needed:** Two tabs, no feed in the second, delayed first journal, quota failure, pending editor typing, sign-out export, and owner recovery after the hold.

5. **R4-5 — should fix before implementation: specify the complete hold-resolution lifecycle.**  
   **Location:** [implementation report:122](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:122); [live.ts:423](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/live.ts:423).  
   **Scenario:** Existing `recheckAccess` sends IDs to `notes.verifyAccess`; local IDs are invalid there. A new resolver also needs protection against late answers, account switches and newer revocations. `allowNotes` alone does not notify readers or schedule creation.  
   **Fix:** Explicitly partition server-note, conflict-source and ordinary-draft resolution. Preserve account epochs and exact hold markers, batch notebook checks to 100, schedule retries and refresh/sync after release. Use `accessLost`/revocation only for definitive refusal.  
   **Proof needed:** Offline reload retains holds without deletion; transient failures later recover; stale answers cannot release newer fences; late BroadcastChannel messages cannot undo release; more than 100 destinations resolve.

No `logout.ts` change may be necessary **once those fencing guarantees are proved**. Its current settlement filtering alone does not establish them.

**Validation run**

- Both app/backend typechecks: passed.
- App: **20 Node + 292 Vitest tests passed**, using local mocks/fake IndexedDB.
- Backend: **211 tests passed**, using `convex-test`.
- Three additional backend probes: passed, with transaction limits—file Trash/Restore, deletion-query bounds/privacy, creation ordering.
- Chromium: **118 passed, 20 skipped**, local Vite with fixture data; desktop and phone emulation.
- Offline: **2 passed**, production build and real service worker with network unavailable.
- Additional local Chromium probes: account-switch disclosure, accessible-conflict-copy rejection, mocked ownership resolution and bare-UUID preview-search exclusion.
- Diff/whitespace checks passed; worktree unchanged.

Not run: real-service E2E scripts, real authentication/Convex/R2, WebKit or a real iPhone. No production contact, commits, pushes or deployments.
