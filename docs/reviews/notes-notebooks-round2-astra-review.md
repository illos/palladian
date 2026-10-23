# Notebook management — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `b017c45..ffa8c8c` on `feat/notes-notebooks`. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

1. **R2-1 — blocking: collaborator offline drafts remain exportable after access loss.** [live.ts:523] catches creation refusals and retains drafts for retry. [cache.ts:1397] excludes uncreated local drafts from notebook-access reconciliation. A local probe applied notebook removal, then ran two syncs returning `not_found`: the draft remained visible and exportable, with four creation attempts. This contradicts D86 and the [reported F3 resolution]. Backend refusal tests do not exercise client cleanup. **Fix:** reconcile destination access for uncreated drafts, including open drafts; prevent export while access is unresolved and revoke the local draft on definitive access loss. Preserve owner recovery and transient-error retention. Add client regression tests.

2. **R2-2 — note: the advertised 5,000-grant preview bound is exceeded.** [notebooks.ts:296] checks `grantsRead > 5000` before reading another batch. A limits-enabled probe with 26 notes and 200 grants each examined 5,200 grants and returned `complete: true`. Results were correct, but the documented cap is inaccurate. **Fix:** limit each read to the remaining budget and disclose any unfinished scan, or document the actual bound.

Otherwise the server fallback is appropriately narrow: authenticated human ownership is checked, the deletion record is written atomically with final deletion, and replay and source-note authorization remain ahead of fallback. No public record-forging path or new error/replay disclosure was found.
