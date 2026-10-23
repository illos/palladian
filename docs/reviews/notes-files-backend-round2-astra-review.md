# Files backend (B1, B2): independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only. Reviewed `b095f8c..e16495b` on `feat/notes-files-backend`.

Responses: "Review round 2 responses" in [notes-files-backend-implementation.md](notes-files-backend-implementation.md).

---

1. **R2-1 — blocking: Deferred verification bypasses connection revocation and destination authorization.** [files.ts:811] reconstructs the actor with `connectionId: null` and never rechecks destination edit access. A local public-`push` test queued an unauthorized reference, revoked the agent connection and destination grant, then granted source access. Verification still created the destination reference, although direct access returned `unauthenticated`. **Fix:** retain the originating connection, recheck destination authority before completing pending work, and prevent later-acquired source permissions from authorizing an earlier unproven reference.

2. **R2-2 — blocking: The lease does not prevent writes completing after cleanup.** [Worker files.ts:197] checks time only before `R2.put`; [backend files.ts:602] assumes writes and clock differences settle within ten minutes. A mocked delayed put crossed that deadline: cancellation was swept and confirmed, bytes subsequently landed, and unavailable finalization left **bytes present with zero queued deletions**. HTTP Workers have no hard wall-time limit. **Fix:** fence writes against deletion or retain durable tombstones for repeated reconciliation; a fixed grace period alone cannot establish completion. Test delayed puts and clock skew, not only slow body reads.

3. **R2-3 — should fix: An accepted authorized copy can permanently lose its attachment during deferred verification.** [references.ts:214] records no durable authorization proof, while [files.ts:833] deletes an exhausted check. Locally, revoking source access between acceptance and verification silently lost the copy's grant. Deleting the source notes also allowed `syncNote` to purge the object despite the surviving destination. **Fix:** establish a bounded source proof at acceptance and preserve it through completion. If proof remains unresolved, expose a recoverable pending result rather than treating the copy as complete.

4. **R2-4 — should fix: Legacy revisions remain readable but cannot be restored.** [history.ts:143] restores through a replacement step, which [document.ts:119] validates strictly. A local test successfully read a stored legacy revision, then `history.restore` rejected it as invalid/unsafe. **Fix:** provide a narrowly scoped restoration path for server-reconstructed historical content, retaining strict validation for client-submitted sources. Add a public history-restore regression.

5. **R2-5 — should fix: Intermediate revisions exceed the attachment limit and become unrestorable.** [documents.ts:183] collects references per step, but [references.ts:167] checks only the final count. Locally, starting with 200 attachments, inserting 200 and then removing the original 200 accepted an intermediate revision containing **400**; restoring that accepted revision failed the 200-object limit. **Fix:** enforce the limit for every accepted revision, or explicitly support restoring larger historical revisions.

The remaining inspected fixes appear sound: bounded permission caching, intermediate-reference collection, fresh service tokens, filename escaping, and uncached deletion batches. Named sources do not directly bypass permissions; replay paths do not reapply grants. Legacy forms grant no access. A6 tables and cleanup scheduling remain intact. The scan is read-only and outputs IDs/counts, but its query must already be deployed before the script can run.
