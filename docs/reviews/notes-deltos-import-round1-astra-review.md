# Deltos import — independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-19. Reviewed `7c75cc6..e725e41` on `feat/notes-deltos-import`. Report recorded verbatim below; responses are in `notes-deltos-import-implementation.md`.

---

Reviewed `7c75cc6..e725e41` independently and read-only. **Changes are needed before production import:** valid nested quote content can disappear without warnings, while conversion and note-count verification still succeed.

1. **F1 — blocking: Quote conversion silently drops nested content.**
   `deltos.ts:215` converts each quote child into a paragraph using only `content.segments`. Code text, list items, attachment filenames, and deeper descendants disappear. Deltos's editor serializer explicitly supports recursive quote children; the limitations of its Markdown exporter are not the document contract.

   A synthetic quote containing code, a list, and a nested quote lost all three descendant texts with **zero warnings**, while producing a valid document. **Fix:** recursively convert quote children with `this.blocks`, preserving block types and IDs; use an empty paragraph only when required. Add tests for nested quotes containing code, lists, to-dos, attachments, and link cards.

2. **F2 — should fix: Title deduplication can select the wrong first line.**
   `deltos.ts:296` compares `textContent`, which omits hard-break separators, against the title. For synthetic title `AB` and first paragraph `A\nB`, it suppresses the title heading; Palladian then derives title `A`.

   **Fix:** compare against the first logical line using Palladian's projection semantics, before title truncation. Test hard breaks, multiline code, and a title followed by body text within the first paragraph.

3. **F3 — should fix: Valid JSON with an invalid body shape is reported as successfully converted.**
   `deltos.ts:310`, together with `list()` at line 63, treats an object, string, or null body as an empty block list. Malformed entries are also silently ignored. Synthetic body `{}` was accepted with zero warnings.

   These are malformed Deltos documents, but the importer should report them as failures rather than create an apparently successful title-only note and delete its staging row. **Fix:** validate the body array and recursive block envelope; retain the open plugin-type contract. Add wrong-root and malformed-child tests.

4. **F4 — should fix: Dry-run validation does not fully match creation's size validation.**
   `imports.ts:46` calls `normalizeNewDoc`, which checks size before adding missing block IDs. Creation subsequently serializes and checks the enlarged document.

   A synthetic document with valid Deltos to-do blocks measured **695,000 JSON characters before normalization and 711,008 afterward**: dry-run conversion accepted it, but creation's `serializeDoc` rejected it. That exception escapes the conversion catch and aborts the batch. The reported 115 KB maximum means this boundary is unlikely to affect this particular export.

   **Fix:** call `serializeDoc` on the normalized document inside `convert`, so both checking and import classify this as a per-row conversion failure. Add a boundary test.

5. **F5 — should fix: Production verification and cleanup need explicit success gates.**
   `notes-deltos-import-implementation.md:59` correctly specifies `--append` and checking before import. However, `remaining === 0` excludes failed rows, and counting 131 keys cannot establish content fidelity—F1 would pass that verification.

   **Fix:** explicitly stop on dry-run or batch failures; reconcile the exact exported ID set against imported client keys; verify owner/notebook placement, dates, and stored document content against reviewed conversion expectations. Compare source text preservation separately so verification does not merely repeat the converter's bug. Report only counts and mismatch IDs. Clear staging only after successful reconciliation, verify it is empty, and then delete the private export. Document failure handling and explicit production targeting for cleanup.

6. **F6 — should fix: Export failures are not guaranteed to remain content-free.**
   `export-deltos.mjs:41` leaves `execFileSync` and response parsing errors uncaught. Subprocess exceptions retain captured stdout/stderr, which Node can print with an uncaught exception; those streams are where database responses travel. Success output contains counts and the output pathname, but the claimed privacy guarantee does not cover failure output.

   **Fix:** catch subprocess and parsing failures and emit a fixed diagnostic with a nonzero exit status, without printing the original exception, output streams, or cause. Test simulated subprocess/parse failures with synthetic content.

7. **F7 — note: Row caps are not byte budgets, and reported counts are capped.**
   `imports.ts:80`, `imports.ts:210`, and `imports.ts:225` read up to 1,000 full staging documents. Thus checking is not necessarily exhaustive, `remaining` is capped, and clearing is one batch rather than an unconditional emptying operation.

   Twenty-five documents at the reported maximum do **not inherently exceed** the transaction write limit: the two JSON copies plus search text are roughly 8.6 MB before other overhead. Nevertheless, staged-row reads and conversion CPU also need budgeting. Convex documents 16 MiB read/write transaction limits and a one-second user-code limit. [Convex limits](https://docs.convex.dev/production/state/limits)

   **Fix:** for this bounded import, record aggregate staged bytes and rehearsal timing; preferably use byte-bounded pagination and a cheap `hasMore` query. Document repeated cleanup until zero. The 131-row claim avoids count truncation, but I could not verify actual data-size headroom without accessing the prohibited export.

8. **F8 — note: Q15 prematurely records completion.**
   `06-decisions-and-acceptance.md:136` says "Notes imported," while the implementation record explicitly says production import is pending.

   **Fix:** say "Import approved/prepared; production execution pending" until verified. D100–D101 and the switch to an internal function otherwise match the stated authorization.

The core import transaction design is sound: idempotency checks use creator plus `deltos:<id>`; only pure conversion errors are caught; notebook and note writes occur outside that catch, so write failures abort the mutation rather than commit partial rows. Notebook names are cleaned before matching/creation, and the default fallback follows the existing owner-only default-notebook invariant. Date patches occur in the creation transaction, with a fresh notebook sequence; I found no missed-feed or cache-ordering defect. History timestamps appropriately remain import-time timestamps.

Ordinary marks, formula source text, code, headings, nested lists, and checklist state are handled coherently. Invalid IDs become null and duplicate/missing IDs are repaired by normalization; I confirmed duplicate-ID repair locally. Unsupported plugin types receive warnings, although arbitrary opaque plugin text cannot be promised preservation. Mixed ordered lists split around to-dos and restart subsequent numbered runs at one; that fidelity change should also be disclosed.

The exporter's SQL interpolations are strictly validated, account selection is scoped, notebook fallback is consistent, and the trash predicate matches valid Deltos date-marker semantics. Extracted page text retains order. The default destination is outside Git with directory/file permissions `0700`/`0600`. All three deployed entry points are internal; no public client or agent import endpoint was added.

**Validation:** `pnpm typecheck` passed; `npx vitest run` passed **69 tests across six files**. Additional in-memory synthetic probes established F1–F4. Missing meaningful tests include those regressions, rollback after a write-stage failure, duplicate staged rows within one batch, feed consumption after an existing cursor, exporter filtering/redaction, and realistic batch-size limits.

No files were edited, committed, or pushed. I did not run the exporter or any Convex command, contact deployments or Cloudflare, or read private import files. Production-export measurements and service-rehearsal claims remain implementer-provided evidence; browser and iPhone checks remain pending.

**Verdict: CHANGES REQUESTED**
