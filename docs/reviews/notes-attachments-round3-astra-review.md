# Inline attachments — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-24. Reviewed `8e7088a..236b5d2` on `feat/notes-attachments`, after the round 2 responses. Report recorded verbatim below; responses are in `notes-attachments-implementation.md`.

---

CHANGES NEEDED

1. **R3-1 — blocking — Concurrent tabs can lose durable cleanup intent.** [attachment-cache.ts:377](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:377)  
   `record()` and `settle()` rewrite a shared list without coordination. In two Chromium tabs, I paused one between reading and rewriting the list and injected IndexedDB marker-write failures. One tab recorded `["bob"]`; the other overwrote it with `["ada"]`. After reopening, Bob’s **29 bytes were readable**, and the list was empty. localStorage writes succeeded, so this is outside the documented dual-storage-failure exception.  
   **Fix:** use independently durable, operation-owned cleanup records, or equivalent coordination that prevents both lost additions and an older clear removing newer intent. Preserve intent until its deletion is verified.

2. **R3-2 — blocking — A pending cache read can return bytes after cleanup completes.** [attachment-cache.ts:262](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:262)  
   I delayed delivery of a completed IndexedDB read, cleared the account in another tab, then resumed the read: it returned **nine old bytes**. The lifecycle comparison uses the earlier transaction’s snapshot; the cleanup list has already been removed. A same-tab `ada → bob → ada` sequence likewise returned three old bytes despite no remaining disk entries. These are cache-level reproductions, not a demonstrated cross-account UI disclosure.  
   **Fix:** capture and validate a read-generation fence across every await. Include a cross-tab invalidation generation that remains observable after cleanup finishes; account-name equality and the old transaction snapshot are insufficient.

3. **R3-3 — blocking for the requested gate-swap guarantee — Turning files off does not stop uploads or downloads.** [editor-attachments.ts:990](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:990), [editor-attachments.ts:657](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/editor-attachments.ts:657)  
   Start an upload, hold admission, then turn files off: its eventual grant still triggers a PUT and writes the byte cache. Insertion is refused, but the remaining **Retry** button triggers another admission and PUT while off. Separately, a held file download completed and cached bytes after its node view disappeared. Worker responses were mocked; this establishes reachable client operations, not successful writes through the real backend gate.  
   **Fix:** invalidate pending attachment work on gate changes, abort transfers, disable retries while off, and recheck the gate before admission, transfer, caching and download delivery.

4. **R3-4 — should fix — Malformed cleanup lists either permit reads or permanently disable caching.** [attachment-cache.ts:96](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:96), [attachment-cache.ts:570](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/attachment-cache.ts:570)  
   `[{"accountId":"ada"}]` is silently filtered to an empty list; Ada’s existing bytes remain readable. Invalid JSON or an unsupported versioned object instead refuses every account indefinitely: sweeping treats the unreadable list as empty and never repairs it. Healthy storage and repeated retention do not recover the legitimate account.  
   **Fix:** validate the complete format strictly, handle supported versions explicitly, and provide fail-closed recovery that verifies deletion before resetting unreadable intent.

5. **R3-5 — blocking for gate enablement only — F4 remains unresolved.** [channel.ts:280](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes/src/channel.ts:280), [references.ts:43](/srv/presidium/projects/palladian/code/.worktrees/attachments/apps/notes-backend/convex/references.ts:43)  
   Pushes still omit `sourceNoteIds`; the fallback still examines only 48 reference rows per change. The previous 49-attachment copy failure therefore remains applicable.  
   **Fix:** implement and independently review the proposed provenance path, including persistence, retries, rebasing, acknowledgement and source-aware batching. This remains a fundamentals integration requirement.

**Release decision:** B3 is not accepted for gate-off release. The original single-tab R2-1 sequence now passes, but cleanup is not fully resolved. **R2-2 and R2-3 are resolved in the tested scenarios.** Initial gate-off rendering matches main; swapping preserves editor history, mid-resize removal works, and an open lightbox closes. Pending operations remain a separate gap.

Validation performed:

- **Typecheck:** passed.
- **Unit tests:** 20 session tests plus 333 Vitest tests passed; mocked services and fake IndexedDB.
- **Local Chromium suite:** 186 passed, 20 skipped, across desktop and mobile emulation.
- **Additional local browser probes:** real editor, IndexedDB and localStorage; synthetic data, injected scheduling/storage failures and mocked attachment services. Covered concurrent cleanup, delayed reads, account switching, malformed formats, gate flips, upload Retry and delayed downloads.
- **Large list:** 1,500 accounts cleared in approximately 1.7 seconds; legitimate caching resumed.
- **Private contexts:** Chromium contexts were isolated. Safari private browsing and actual storage-partition configurations were not tested.
- **Regression review:** no additional regression found in A3, files-gate assertions, fixture History, Duplicate/actions, pins or notebooks. The selector change preserves assertions across both renderings; the title assertion strengthens coverage. Specified fundamentals and backend files remain unchanged.
- **Not run:** real-service e2e, a fresh convex-test F4 reproduction, Worker/R2 integration, actual quota exhaustion, WebKit, assistive technology or a real iPhone.

No production contact, commits, pushes or deployments. Worktree remains clean.
