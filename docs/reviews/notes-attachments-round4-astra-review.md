# Inline attachments — independent review, round 4

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-24. Reviewed `8e7088a..0c7dcb9` on `feat/notes-attachments`, after the round 3 responses (memory-only byte cache). Report recorded verbatim below; responses are in `notes-attachments-implementation.md`.

---

CHANGES NEEDED

1. **R4-1 — blocking for the requested clear/gate-swap guarantee — Pending reads can survive a clear.** [editor.tsx:925](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor.tsx:925), [editor-attachments.ts:673](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:673)  
   Reproduced in the real editor: hold a download, call `setFiles(false)` then `setFiles(true)` in one browser task, and release the response. React batches the changes, so the runtime misses the off transition. The cache epoch advanced, yet **one download started**. Nothing was cached. A separate runtime probe likewise delivered after `cache.clear()`. Tickets fence storage, but not delivery.  
   **Fix:** invalidate pending runtime work synchronously on every off transition, independently of React rendering, and validate the captured cache/lifecycle epoch before returning or delivering bytes. Add rapid off→on and clear-during-read regressions.

2. **R4-2 — should fix before enabling — Uploads do not fence session generations.** [editor-attachments.ts:987](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:987), [editor-attachments.ts:1031](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:1031)  
   In the editor harness, I held admission, advanced the session generation, then released admission. The old upload performed **one PUT and inserted a file block**. `current()` checks cancellation, attempt and gate; `service()` checks account but not generation. This contradicts the claimed generation checks after every await. This was a component reproduction, not a demonstrated production account-switch disclosure.  
   **Fix:** capture account and generation for each upload, invalidate it when either changes, and release late admissions through the originating service.

3. **R4-3 — blocking for gate enablement only — F4 remains unresolved.** [channel.ts:280](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/channel.ts:280), [references.ts:43](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes-backend/convex/references.ts:43)  
   Pushes still omit `sourceNoteIds`; fallback proof still has a 48-row budget per change. The previously reproduced 49-attachment copy failure remains applicable.  
   **Fix:** implement and independently review provenance through clipboard, journal/channel, retries, acknowledgement, rebasing and source-aware batching before enabling files.

The persistent-storage causes of **R3-1, R3-2 and R3-4 are removed**. I found no attachment-byte persistence path in IndexedDB, localStorage, Cache Storage or the service worker. Ada→Bob→Ada and stale-ticket tests passed. An actual App/session probe confirmed clearing occurs synchronously before a subsequently registered session listener can read old bytes. The stronger pending-delivery guarantee remains incomplete under R4-1.

All three specified **R3-3 scenarios with files remaining off passed**, as did F3’s existing regressions, F5–F8, main-equivalent gate-off rendering and editor-state preservation across ordinary gate swaps. No additional regression surfaced in A3, History, actions/Duplicate coverage, pins or notebooks.

The 64 MiB cache cap and LRU eviction passed a full-size probe: three 25 MiB entries, with the oldest touched, retained the expected two entries totaling 50 MiB. Repeated note changes created and revoked **16/16 blob URLs**; destroyed runtimes retained no object records. This bounds the cache, not total memory used by displayed images.

**Release decision:** starting and remaining gate-off has no identified new visible behavior or reachable B3 upload/byte-persistence path. However, I cannot accept the requested lifecycle and gate-swap guarantees as submitted. F4 independently continues to block enablement.

The persistent-cache proposal is directionally sound: sharing the notes store’s lifecycle avoids another cleanup protocol. It still needs atomic byte/metadata accounting, post-await read fencing, cross-tab invalidation and failure/recovery tests—not merely placement in the same database.

Validation performed:

- **Typecheck:** passed.
- **Unit tests:** 20 session tests + 321 Vitest tests passed; mocks, fake IndexedDB and simulated service-worker caches.
- **Local Chromium:** 184 passed, 20 skipped; desktop and mobile emulation.
- **Additional local browser probes:** real editor/cache/session code with synthetic bytes and mocked services; clear fencing, rapid gate cycling, upload generation changes, synchronous App cleanup, full-size LRU pressure and URL/runtime cleanup.
- **Not run:** remote dev-service e2e, fresh convex-test provenance reproduction, actual Worker/R2 integration, WebKit, screen-reader testing or a real iPhone.

No production contact, repository edits, commits, pushes or deployments. Worktree remains clean.
