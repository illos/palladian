# Notebook management — independent review, round 5

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `b39fed7..dc1d665` on `feat/notes-notebooks`, with R3-1/R3-3 excluded as awaiting the owner, and a design review of the revised fundamentals proposal. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

CHANGES NEEDED

**Implemented A5 is accepted apart from the explicitly excluded R3-1/R3-3.** R4-1 and R4-2 are resolved; R3-2/R3-4 still hold. I found no additional release blocker or regression to A2/A6/A3/B1+B2/A4. The following findings concern **the unimplemented proposal**.

1. **R5-1 — blocking: destination verdicts cannot settle lost creation replies.**  
   **Location:** [implementation report:161](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:161), also line 167; [notes.ts:174](/srv/presidium/projects/palladian/code/.worktrees/notebooks/apps/notes-backend/convex/notes.ts:174).  
   **Scenario:** Creation succeeds but its reply is lost. The note subsequently moves and remains accessible through a direct grant, while the original notebook becomes inaccessible. The proposed destination resolver returns `denied` and purges legitimate pending work before replay can recover the note. Conversely, a writable destination can contain a now-inaccessible replay: releasing its draft exposes work that the replay check refuses. Two transaction-limited backend probes confirmed these combinations.  
   **Fix:** Resolve each potentially completed creation by account and `clientKey` before applying destination-based release or purge. Preserve accessible replay recovery and fence denied replays independently. Keeping precedence inside `notes.create` does not protect decisions made before calling it.

2. **R5-2 — blocking: denial drops the fence around another tab’s memory-only drafts.**  
   **Location:** [implementation report:162](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:162).  
   **Scenario:** Tab B has a quota-failed first journal or queued draft absent from IndexedDB. Tab A receives `denied`, enumerates its own memory and persisted drafts, revokes those IDs, then deletes the destination hold. B’s unknown ID receives no revocation; after the hold disappears, its draft becomes exportable again. A two-tab Chromium probe confirmed that the existing enumeration/revocation mechanism cannot discover B’s quota-only draft.  
   **Fix:** Persist a destination-level denial that remains effective for unseen drafts and queued writes. Each tab must apply it to its own memory, with an explicit lifecycle for subsequent reauthorization. Do not clear the only shared fence after revoking merely the IDs visible to the resolver.

3. **R5-3 — should fix: the message rule resurrects released holds.**  
   **Location:** [implementation report:165](/srv/presidium/projects/palladian/code/.worktrees/notebooks/docs/reviews/notes-notebooks-implementation.md:165).  
   **Scenario:** Hold H is released and deleted. Its delayed `heldDestinations` message arrives. The specified “no hold or an older one” rule accepts H again, contradicting the claimed protection against late messages.  
   **Fix:** Treat messages as notifications to reread authoritative persisted state, as existing cache fence handling does, or retain durable resolution versions. Require exact-marker transactional transitions; absence alone cannot authorize recreating a hold.

**Proposal assessment**

The non-writing `notes.destinationAccess` mutation is a sound primitive: mutations can read database state transactionally without performing writes. It avoids subscription-cached answers, but its verdict is permission at execution time—not a continuing guarantee. [Convex documentation](https://docs.convex.dev/functions/mutation-functions)

Its proposed response exposes no additional unauthorized notebook information: inaccessible, unknown and other-person-deleted destinations remain indistinguishable; positive answers concern the caller’s own permissions or deletion. Human authentication, account matching and bounded inputs must precede resolution.

The destination-hold approach remains reasonably scoped, but the lifecycle is incomplete. The proof plan needs both replay combinations above, hold→denial with another tab’s quota-only/queued work, and delayed messages after release/reload. Also prove account/generation/epoch rejection and failure to persist a fence. Existing proposed tests cover initial holding better than final disposition.

These gaps can destroy recoverable work or release protection incorrectly: **not ready**.

**Validation run**

- Both app/backend typechecks passed.
- App: **20 Node + 295 Vitest** tests passed; mocks/fake IndexedDB.
- Backend: **211 tests**, plus **2 additional replay probes**, passed using `convex-test`; additional probes enforced transaction limits.
- Local Chromium suite: **120 passed, 20 skipped**, desktop and phone emulation.
- Additional Chromium probes passed for A → B → A account isolation; direct-grant/moved-source copies; source-loss fencing across two tabs, including read/list/export/sync exclusion; and mocked positive ownership resolution after reload. Account-switch settlement, cleanup and identity responses were mocked.
- Production-build offline suite: **2 passed**, local preview and real service worker with network disabled.
- Protected files and all four protected App functions are unchanged. Worktree remains clean.

Not run: real-service E2E scripts, real authentication/Convex/R2, WebKit or a real iPhone. No production contact, commits, pushes or deployments.
