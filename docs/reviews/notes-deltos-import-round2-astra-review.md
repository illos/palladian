# Deltos import — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-20. Reviewed `7c75cc6..6ffb42d` on `feat/notes-deltos-import`, including the round 1 fixes. Report recorded verbatim below; responses are in `notes-deltos-import-implementation.md`.

---

Reviewed `7c75cc6..6ffb42d`, including the round 1 fixes, independently and read-only. **Two issues remain before production import: verification can approve missing content, and interrupted operations lack a complete recovery path.**

1. **G1 — should fix: Text verification can approve deleted paragraphs.**
   `imports.ts:329`

   Every source piece is checked with `stored.includes(piece)`. One surviving occurrence satisfies any number of identical source pieces; text elsewhere in the document can also satisfy a missing block's requirement.

   **Reproduced with the actual functions in `convex-test`:** imported two identical paragraphs, deleted one from `noteContent`, then ran the runner's verification and cleanup. Both passed, and cleanup deleted the staging row.

   Add a comparison that preserves occurrence counts and order, accounting explicitly for title deduplication and generated placeholders. A comparison against the expected converted document, ignoring generated IDs, would provide an additional check on stored structure and marks; retain an independent source-preservation check to catch converter bugs. Add regression tests for repeated paragraphs, overlapping text, and reordered blocks.

2. **G2 — should fix: Partial import and cleanup cannot resume through the runner.**
   `deltos-runner.ts:173`, `deltos-runner.ts:224`, implementation procedure line 59

   After one import batch commits, its rows leave the pending index. Retrying `import` compares the remaining pending IDs against the entire export and refuses with "check failed; nothing imported." After one cleanup batch commits, retrying `clear` fails because verification requires the deleted staging rows.

   **Both reproduced in memory** by injecting a failure before the second batch. Existing notes and remaining staging survive, but the ordinary commands cannot finish.

   Either support recovery explicitly—reconcile pending and already-linked rows, verify completed work, then continue—or document and test a safe reset/re-stage procedure using the unchanged export and existing idempotency keys. Correct the abandonment instruction too: the displayed `clearDeltos` call deletes **at most 25 rows**, rather than emptying the table; it must repeat until `more === false`. Keep the export until recovery and verification finish.

3. **G3 — note: The byte budget is an estimate, not a transaction read bound.**
   `imports.ts:185`, `imports.ts:202`

   `.take(25)` reads all selected staging documents before the budget loop starts. The accounting uses UTF-16 string lengths, excludes some fields and overhead, and permits the final processed row to cross the threshold. Verification and cleanup are also bounded by row count.

   The reported sizes provide reasonable headroom for this particular export. They do not establish a general byte-bound guarantee: Convex limits transaction reads and writes to 16 MiB each. [Convex limits](https://docs.convex.dev/production/state/limits)

   Keep this limitation explicit. If broader inputs are supported, measure encoded bytes and bound reads before fetching full batches. The current large-note test proves early stopping, not compliance with service limits.

4. **G4 — note: Export tests do not establish SQL account isolation.**
   `export-deltos.test.ts:38`

   The fake wrangler returns fixtures based on broad SQL substrings. Removing username/account or `deletedAt` predicates would still let the success test pass. The actual SQL predicates look correct; strengthen the fake's argument assertions or use fixtures that distinguish accounts and deleted rows.

   Trash-marker filtering, extraction order, permissions, and subprocess-output redaction are meaningfully tested. Runner tests exercise its library functions; CLI argument parsing, subprocess redaction, and stage refusal still lack automated coverage.

**Round 1 disposition:** F1–F4, F6, and F8 are resolved. F5 is substantially improved but remains incomplete because of G1 and G2. F7 is mitigated for the reported dataset, with G3's limitation. Ordered-list numbering now continues across to-do splits.

The pending index correctly requires both `failure === undefined` and `noteId === undefined`. Existing-note imports link staging rows without creating duplicates. Write-stage errors remain outside the conversion catch, preserving transaction rollback. Verification checks ownership, creator, lifecycle, notebook placement, dates, and exact exported/staged/imported ID sets.

Additional synthetic checks found **no false verification failures** for whitespace, hard breaks, merged text runs, link-card labels, attachment placeholders, formulas, the extraction marker, or long titles. The nested-quote fix preserves the tested descendant types and IDs.

**Validation:** `pnpm typecheck` passed; `npx vitest run` passed **90 tests across seven files**; diff whitespace checks passed. Additional probes used synthetic data and in-memory `convex-test`. The permitted suite exercised the exporter against fake wrangler; I did not run the real exporter, runner CLI, or any Convex CLI command. No deployment, Cloudflare, or private-export access occurred. Production measurements and rehearsal results remain implementer-provided evidence; browser and iPhone checks remain pending.

No source files were edited, committed, or pushed. The pre-existing untracked `.gitignore` remains untouched.

**Verdict: CHANGES REQUESTED**
