# Notebook management — independent review, round 1

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `3af8da4..b017c45` on `feat/notes-notebooks`. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

CHANGES NEEDED

1. **F1 — blocking: deletion on another device can cause local typing loss.** Navigation changes only in the deleting device's callback ([App.tsx:1413]). Other devices retain the deleted notebook as their selected destination, with New note enabled. Creation then returns `not_found`; [channel.ts:304] invokes [App.tsx:605], which revokes the local note and deletes its draft. A local channel/store probe reproduced deletion of previously saved typing. **Fix:** reconcile the selected notebook when authoritative inventory changes, and preserve uncreated drafts on destination errors instead of treating them as revoked server notes.

2. **F2 — blocking: the fixed batch exceeds transaction byte limits for valid notes.** [notebooks.ts:255] processes 50 notes; each move reads and patches the full search projection ([lifecycle.ts:269]). With transaction limits enabled, 50 notes created through the normal API with 400,000-character bodies make deletion fail its byte budget. The batch rolls back, so retries cannot progress. **Fix:** bound read/write bytes as well as row counts, accounting for Trash's additional projection access. Add large-document coverage; the existing 120-note test uses tiny bodies.

3. **F3 — should fix: offline drafts targeting the deleted notebook remain stranded.** [live.ts:548] always submits the saved notebook ID; its caller silently retains failures for another retry. A local probe confirmed repeated attempts against the same missing destination with no recovery. **Fix:** preserve the draft and provide a destination chooser or an explicit default-notebook fallback, retaining creation idempotency and conflict-copy authorization checks.

4. **F4 — should fix: the access-loss preview is incomplete.** [notebooks.ts:225] excludes destination members when `trash:false`, but deletion restricts already-trashed notes regardless ([notebooks.ts:269]). A probe returned `lost: []` for a member of both notebooks who subsequently lost access. Separately, [lifecycle.ts:172] silently truncates at 200 members; a 201-member probe confirmed the omission. **Fix:** account for existing Trash and effective per-note overrides, and paginate or explicitly disclose incomplete results.

5. **F5 — should fix: deletion can proceed before its warning loads.** The confirmation button only checks `busy` ([panels.tsx:1025]); submission does not require a valid preview. A mocked render confirmed the button remains enabled with the preview unresolved. **Fix:** disable and guard submission until the preview for the current destination and Trash choice is available; handle null/error states explicitly.

Validation: 126 backend tests, 145 app tests, both typechecks, 62 browser tests, and two offline tests passed. Nine temporary probes checked the findings, public-link Trash/Restore behavior, agent grants, and a default change between batches. No ownership bypass was found.
