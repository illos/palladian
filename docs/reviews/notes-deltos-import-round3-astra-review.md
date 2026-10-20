# Deltos import — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-20, scoped to issues blocking this import. Reviewed `6ffb42d..e61b99c`. Report recorded verbatim below; the response is in `notes-deltos-import-implementation.md`.

---

Reviewed `6ffb42d..e61b99c`, with the full change and previous reviews as context. One blocking verification gap remains.

1. **H1 — blocking: A prepended title can still satisfy missing body content.**
   `apps/notes-backend/convex/deltos.ts:448`

   `pieces[0].startsWith(title)` does not establish whether conversion prepended a title. Conversion compares the first **rendered logical line**, which can differ from the first source piece.

   **Reproduced using the actual import, verification and cleanup functions in `convex-test`:** a synthetic note titled `Report.pdf`, containing an attachment named `Report.pdf` followed by a paragraph, converts to a title heading, attachment placeholder and paragraph. After deleting the entire attachment placeholder, verification still passed: the heading satisfied the attachment's source-text requirement. Cleanup also passed and deleted the staging row.

   A second local reproduction used title `A` and body `A A`. Conversion prepends a heading. Shortening the body to `A` still passed because matching consumed the heading plus the remaining body text.

   **Required fix:** determine whether the title was prepended using the conversion's actual first-line decision, and exclude that generated heading from body matching. Retain ordered, non-overlapping matching and add these regressions. This is a remaining instance of G1, not a large-input concern.

The relaxed `runImport` precheck still ends with strict reconciliation of all staged and imported IDs, so missing rows cannot yield successful completion. Cleanup recovery is sound under the documented sequence: full verification precedes the first deletion, remaining rows are reverified on retry, and imported IDs must still match exactly. I found no additional blocker there.

Valid synthetic cases passed for prepended and deduplicated titles, title prefixes, hard breaks, link cards, attachment placeholders, extraction-marker titles, nested quotes and lists. I did not independently inspect the private dataset or verify the reported 131-note result.

**Validation:** `pnpm typecheck` passed; `npx vitest run` passed **92 tests across seven files**. Additional probes used synthetic data and local, in-memory execution. Exporter tests used fake Wrangler. No real export, runner CLI, Convex CLI, deployment access, private-export access, browser or iPhone checks occurred.

No source files were edited, committed or pushed. The pre-existing untracked `.gitignore` remains untouched.

**Verdict: CHANGES REQUESTED**
