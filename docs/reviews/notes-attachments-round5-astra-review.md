# Inline attachments — independent review, round 5

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-24. Reviewed `8e7088a..8451709` on `feat/notes-attachments`, after the round 4 responses. Report recorded verbatim below; responses are in `notes-attachments-implementation.md`.

---

CHANGES NEEDED

1. **R5-1 — blocking for the F3 invalidation guarantee / enabling B3 — Pending downloads survive object invalidation.**  
   [editor-attachments.ts:585](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:585), [editor-attachments.ts:655](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:655)  
   Reproduced through the real file-chip keyboard handler with mocked responses: hold a download, remove its object from the authoritative list, publish `null` as the subsequently unknown list, then release the response. The request was **not aborted; one download started and bytes re-entered the cache**, while the chip remained unavailable. Removing and then restoring the object also permits the old delivery.  
   **Fix:** give downloads an object-specific invalidation generation and abort controller. Authoritative removal must permanently invalidate that attempt, independently of subsequent list changes. Require a fresh activation after access returns.

2. **R5-2 — should fix before enabling — Retry can strand an older admission.**  
   [editor-attachments.ts:1286](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:1286)  
   Hold admission A, advance the session generation, Retry, let admission B complete its PUT and land, then resolve A. I observed **two admissions, one PUT, B inserted, and zero cancellations**. The unconditional `task.landed` return discards A because the reused task landed B. This leaves F7 and R4-2’s cleanup claim incomplete.  
   **Fix:** distinguish the landed request/object from superseded admissions. Preserve B, but cancel A through A’s originating service. Add this ordering to the regressions.

3. **R5-3 — blocking for gate enablement only — F4 remains unresolved.**  
   [channel.ts:280](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/channel.ts:280), [references.ts:43](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes-backend/convex/references.ts:43)  
   Pushes still omit `sourceNoteIds`; fallback proof still examines only 48 reference rows per change. The previously reproduced 49-attachment copy failure remains applicable.  
   **Fix:** implement and independently review provenance through clipboard, journal/channel, retries, acknowledgement, rebasing and source-aware batching.

**R4-1 is resolved in the tested sequences.** R4-2’s generation fencing also passes; its late-admission cleanup needs R5-2.

**Gate-off release decision:** starting and remaining files-off is acceptable. I found no new visible behavior, reachable B3 upload/byte-persistence path, or additional gate-off release blocker. Main-equivalent rendering and state-preserving gate swaps pass. Enabling B3 remains blocked.

Validation performed:

- **Typecheck:** passed.
- **Unit/session tests:** 20 + 322 passed; mocked services, fake IndexedDB and simulated service-worker caches.
- **Local Chromium suite:** 194 passed, 20 skipped, across desktop and mobile emulation. Includes A3, files gate, fixture History, actions/Duplicate, pins and notebooks; no additional regression identified.
- **Independent local browser probes:** real editor/runtime/cache with synthetic data and mocked services. Passed off→on→off, clear followed immediately by a new read, two editors, lightbox closure, and generation changes during file reading, hashing, note creation, both admission waits, PUT, and between caching and insertion. Ordinary Retry passed; the earlier-admission ordering exposed R5-2.
- **Memory/cache:** full-size LRU probe retained the expected 50 MiB under the 64 MiB cap; all 8 generated image blob URLs were revoked. No attachment-byte persistence path found. F5/F6/F8 regressions passed; F3/F7 retain the gaps above.
- **Lint:** branch and main `8e7088a` fail with the same 30 boundary diagnostics in unchanged `packages/notes-core` files.
- **Not run:** remote dev-service e2e, fresh convex-test F4 reproduction, Worker/R2 integration, WebKit/Safari, screen reader or real iPhone.

No production contact, repository edits, commits, pushes or deployments. Worktree remains clean.
