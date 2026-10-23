# Files backend (B1, B2): independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `11d8fea..3410d7c` on `feat/notes-files-backend`.

Responses: "Review round 1 responses" in [notes-files-backend-implementation.md](notes-files-backend-implementation.md).

---

CHANGES NEEDED

1. **F1 — blocking: Valid attachment edits exceed transaction limits.** [references.ts:65] repeats permission queries for every object. A local `convex-test` fixture with `transactionLimits: true` failed when copying **200 authorized attachments**, each readable through its eighth reference: "Too many index ranges … limit: 4096." Existing file tests leave limit enforcement disabled. **Fix:** deduplicate permission lookups, support a verified source-note reference, and prove the complete commit stays within limits with enforcement enabled.

2. **F2 — blocking: Intermediate accepted revisions lose their attachment references.** [documents.ts:210] records only the documents before and after the entire push, although each step becomes a revision. A local two-step insert/remove push produced revision 1 containing the attachment but **zero reference rows**. Historical byte reads consequently fail, and the object can receive never-referenced cleanup instead of historical-object retention. **Fix:** collect authorized references across every accepted intermediate revision; set `current` and `live` from the final document.

3. **F3 — blocking: Cancellation can leave R2 bytes permanently outside cleanup.** An admitted upload can outlive cancellation and its deletion sweep, then write bytes. If finalization fails, [Worker files.ts:203] retains them. The failed record is subsequently removed without another deletion request at [backend files.ts:684]. A mocked interleaving reproduced bytes remaining with an empty deletion queue. They remain inaccessible, but physical cleanup is lost. **Fix:** coordinate admitted writes with durable upload leases/tombstones and retry reconciliation until late writes are impossible.

4. **F4 — should fix: The eight-reference cutoff silently breaks authorized copies.** [references.ts:71] examines only eight current and eight historical references. A local fixture returned `sourceRole: "read"` but `canUseObject: false` when the readable source was ninth. The destination saves without a usable attachment grant. **Fix:** accept and verify a source-note identifier or another complete, bounded authorization proof; do not interpret a truncated search as definitive denial.

5. **F5 — should fix: Slow uploads outlive their service credentials.** [files.ts:169] creates one service client before reading the body and reuses it for finalization. Its JWT lasts only [60 seconds] (jwt.ts:109). A simulated 61-second upload wrote bytes but returned `unavailable`; equally slow retries repeat the failure. **Fix:** refresh service credentials before finalization and during long deletion sweeps, preserving the short token lifetime.

6. **F6 — should fix: Valid filenames break Markdown round trips.** [markdown.ts:408] does not escape autolink delimiters, while attachment parsing selects the [first closing link token] (markdown.ts:184). A validated file named `contact <x@y.com>.pdf` serialized successfully but reparsing threw "Cannot read properties of undefined (reading 'level')". **Fix:** escape angle brackets in filenames, match closing tokens structurally, and add email/URL-autolink round-trip cases.

7. **F7 — note: The compatibility scan must include history.** The [deployment instructions] (implementation report:177) scan only `noteContent`. Older attachment syntax can remain in checkpoints or steps after disappearing from current content. **Fix:** extend the pre-deployment scan to retained history and define compatibility handling before enabling stricter validation. Production data was not inspected.

Verification: core 44, backend 145, Worker 101, and app 144 tests passed; all requested typechecks passed. Two backend tests initially timed out during parallel execution; the standalone rerun passed. Checks used Node, `convex-test`, mocked services, and local R2 simulation.
