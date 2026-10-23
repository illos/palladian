# Files backend (B1, B2): independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only. Reviewed `0042ef8..bbc04a2` on `feat/notes-files-backend`.

Responses: "Review round 3 responses" in [notes-files-backend-implementation.md](notes-files-backend-implementation.md).

---

1. **R3-1 — blocking: A late upload can delete a ready object's bytes.** Retries evict old tickets at [backend files.ts:245]. Finalization checks the ticket before checking `ready` at [files.ts:394], and the Worker deletes any late write receiving `denied` at [Worker files.ts:237]. Local reproduction using actual backend functions: admit upload, issue five retries, finalize a retry, finish the original write after its lease. Result: **state `ready`, bytes absent, zero tombstones**. The existing mocked test at [files.test.ts:649] explicitly expects this unsafe deletion. **Fix:** delete only after an authoritative terminal-state decision; ticket rejection does not establish that the object cannot be ready. Add this combined backend/Worker regression.

2. **R3-2 — should fix: Named sources do not reliably authorize historical attachments for editors.** [references.ts:131] accepts only `current` references, despite historical access being valid for editors. With 48 inaccessible current references preceding a named historical source, my local public-API test returned **source access `granted`, copied attachment access `denied`**. Read-only historical access correctly remained denied. **Fix:** apply the existing current/read versus historical/edit rule to the exact named-source lookup, without depending on the fallback search budget.

3. **R3-3 — blocking: The stated deployment order does not close the old-client compatibility gap.** The report recommends keeping the backend-to-Worker interval short at [implementation report:201]. However, [offline-plugin.ts:64] deliberately keeps the previous build until all its windows close. I loaded the actual `0042ef8` schema against a new file document: **`Unknown node type: file`**. Existing A3 clients can therefore remain incompatible after both deployments. **Fix:** deploy compatible readers first and gate new-schema writes until a safe client-upgrade prerequisite is satisfied; document and test that rollout.

4. **R3-4 — note: The requested transaction-limit guarantee has an inherited history gap.** Checkpoints depend on revision count at [documents.ts:220]; reconstruction reads the intervening steps at [documents.ts:343]. With limits enabled, 35 public pushes containing approximately 490 KB replacements succeeded, but reading revision 34 and restoring revision 1 both exceeded **16 MiB read**. This mechanism predates this branch. **Fix:** bound checkpoint spacing by accumulated bytes, avoid replaying current history unnecessarily during restore, and add large-history limit tests.

The remaining inspected fixes look sound: no deferred verifier, transaction-scoped authorization and revocation checks, durable proven copies, replay paths that do not upgrade grants, narrowly scoped legacy restoration, and intermediate attachment-count enforcement. New reference and cleanup batches are bounded. Tombstones still permit the documented residual escape after seven days.
