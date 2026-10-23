# Notebook management — independent review, round 6 (fundamentals proposal)

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. A design review of the revised "Proposed fundamentals change (needs owner approval)" at `65222bc` on `feat/notes-notebooks`; code was unchanged since round 5. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

NOT READY

R5-1 is addressed by checking each draft’s replay before its destination. R5-2’s specific unseen-draft problem is addressed by retaining the destination fence. R5-3 is addressed by notification-only messages and persisted markers. However, fence establishment and storage-failure recovery still leave D86 gaps.

1. **R6-1 — blocking: failed fence persistence does not survive reload, and an old fence can satisfy the recovery condition.**  
   **Location:** [report:167](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:167), [report:187](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:187).

   **Scenario:** A tab learns that notebook access was removed, but the fence transaction fails. The old notebook list survives; only memory and a BroadcastChannel notification record the failure. After the tabs close, an offline reload finds the old list and no fence. The upgrade pass does not help—the notebook is still listed—and the draft becomes exportable again.

   There is also a problem without reloading: if an earlier `released` record exists, the failed transaction preserves it. Another tab’s reread already “finds the fence,” although it is the old release against which its draft was approved.

   **Fix:** Specify a failure protocol that survives restart, or a conservative startup/export gate that requires fresh resolution when durable safety cannot be established. Preserve the work while blocked. Recovery must identify the successful replacement of the failed fence operation, including account lifecycle and marker; finding any record is insufficient. Add failed-write → old-release, failed-write → offline reload, and late failure-notification tests.

2. **R6-2 — blocking: an incomplete snapshot can erase the baseline needed to establish a fence.**  
   **Location:** [report:160](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:160); [live.ts:316](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/live.ts:316), [cache.ts:1485](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/cache.ts:1485).

   **Scenario:** The cached list contains notebook N. An incomplete snapshot omits N and replaces the list; the proposal correctly does not infer loss from that incomplete snapshot. A later complete snapshot also omits N. Comparing the old and new lists now finds no removal, so no destination fence is created. Existing `reconcileAccess` does not cover ordinary local drafts. If creation cannot obtain a definitive response, sign-out can still export the draft despite the complete snapshot establishing the notebook’s absence.

   **Fix:** Preserve a durable reconciliation baseline across incomplete snapshots—for example, retain previously known notebook IDs until a complete snapshot reconciles them. Also reconcile persisted ordinary-draft destinations against complete snapshots, rather than relying solely on an old/new list difference. Preserve destination-level protection for another tab’s unseen memory-only work. Add incomplete → complete omission coverage; the one-time upgrade scan is insufficient.

3. **R6-3 — should fix: “skip fenced drafts in settlement” can silently discard recoverable work.**  
   **Location:** [report:172](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:172), [report:191](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:191); [cache.ts:914](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/cache.ts:914), [main.tsx:86](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes/src/main.tsx:86).

   **Scenario:** The owner’s only draft is held pending confirmation that they deleted its notebook. An implementation literally excluding it from `settlement` reports no unsaved work. `hasDrafts` then allows logout without the draft dialog, and account cleanup deletes it. Likewise, excluding held work from the count can allow “Export saved” to confirm an incomplete export.

   **Fix:** State the return contract explicitly: exclude fenced drafts from `settlement.drafts`, but include all retained, unresolved drafts in `total` and `held`. A destination denial alone must not remove those counts: an individual draft may still recover through an accessible replay. Only definitive per-draft disposition removes its retained-work count. Test logout, account switching, “Wait for save,” and export confirmation with only held work and with mixed work.

4. **R6-4 — note: destination-only resolution is redundant and creates avoidable marker coordination.**  
   **Location:** [report:169](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:169), [report:180](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:180), [report:183](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:183).

   **Scenario:** A draft receives `writable` against marker H. Destination resolution changes H to released marker R. The draft’s answer cannot authorize R under the exact-marker rule; it needs another check. The phrase “once the record is released” leaves this ordering implicit.

   **Simplification:** Keep a durable destination invalidation marker and require each affected draft to resolve against it. Positive per-draft verdicts release that draft; negative verdicts revoke it; unseen drafts remain fenced. Destination-only requests and the three destination states can then be dropped without losing the stated guarantees. If retaining them, explicitly require a new per-draft request after the marker changes—never transfer H’s authorization to R.

`notes.creationVerdict` introduces no identified unauthorized-information disclosure beyond what callers can establish through `notes.create`. Replay lookup remains caller-scoped, inaccessible replays disclose no note ID, and positive destination answers concern the caller’s permissions or deletion. Sharing a **read-only decision helper** is sound. Keep human-only enforcement on the new endpoint, preserve existing agent behavior in `create`, and leave document creation and replay-content loading outside the helper. Otherwise, batching 100 accessible replays could unnecessarily read 100 large documents.

The proof plan is substantially improved but is not yet sufficient. Add the scenarios above, large-document replay batches, and marker/account/epoch changes **during** asynchronous adoption or revocation—not just before entering the response handler. The per-draft commit must atomically validate its captured fence. With the current gaps, an implementer still has to invent consequential recovery and settlement behavior.

Validation and probes run:

- Confirmed clean worktree at `65222bc`; changes since `dc1d665` are documentation only.
- Reviewed the proposal against D86 and the specified cache, live, logout, App and backend paths; also inspected channel and sign-out integration.
- **33 app tests passed**, covering existing holds, settlement, late messages and notebook actions; mocks/fake IndexedDB.
- **25 backend tests passed** in `notebooks.test.ts` and `notes-account.test.ts`; `convex-test`.
- Two synthetic fake-IndexedDB probes confirmed existing-code behavior: failed notebook-list writes leave no surviving failure evidence after reopening; incomplete → complete omission produces no old/new removal and leaves the ordinary draft exportable. These validate the proposal’s underlying assumptions, not an implemented destination-fence feature.
- No browser, real-service or iPhone checks. No production contact, source edits, commits, pushes or deployments.
