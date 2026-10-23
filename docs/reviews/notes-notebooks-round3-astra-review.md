# Notebook management — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `8bd5439..6ad0f1d` on `feat/notes-notebooks`. Report recorded verbatim below; responses are in `notes-notebooks-implementation.md`.

---

1. **R3-1 — blocking: sign-out still exports unavailable drafts.** Chromium reproduced Settings → Sign out → Export drafts downloading the collaborator's complete draft after notebook removal and access reconciliation. [logout.ts:103] calls `exportDrafts`; [cache.ts:914] excludes fenced drafts, but these drafts are never fenced. The [report:75] correctly acknowledges retention and retries but overstates protection against reading/copying. **Fix:** obtain separate authorization for the shared cache/sync access-fencing change, covering export and definitive refusal while preserving transient-error retention. Explicitly document that in-app export remains possible meanwhile.

2. **R3-2 — blocking: the app guard leaves content-reading paths open.** [App.tsx:1933] still renders the draft's first line; [App.tsx:1318] searches its hidden preview. Chromium confirmed both. Additionally, [notebook-actions.ts:120] recognizes only `local-` IDs, although supported legacy drafts use bare UUIDs. A UUID draft remained fully readable through its row and deep link. **Fix:** use `isLocalNoteId`, redact content-derived titles, exclude unavailable content from search, and enforce access at the shared opening path. Extend the [browser regression:379], which currently locates the supposedly hidden draft by its exposed text.

3. **R3-3 — blocking: another tab can retain the complete open draft.** In a two-tab Chromium probe, removing a notebook containing only local drafts and reconciling access closed the first tab's editor; the second retained readable text. [cache.ts:1400] excludes these drafts, so the cross-tab hold notification at [cache.ts:1451] never fires. **Fix:** include uncreated drafts in shared access reconciliation and broadcast their holds/revocations; test a second tab without its own live feed. This belongs in the separately authorized fundamentals work.

4. **R3-4 — should fix: owner recovery depends on the current tab's memory.** Ownership history exists only in [App.tsx:261]. After notebook removal, the owner's draft opened normally; reloading marked that same draft "Not available" because the historical role was lost. **Fix:** preserve account-bound ownership evidence across reloads, or resolve owner recovery explicitly, without treating unknown ownership as permission. Add reload/new-tab owner coverage.

5. **R3-5 — note: R2-2 and the inspected A6 integration are correct.** Retain the integration probe as regression coverage (quota reclamation at 100 orders, version continuity, preserved pins, surviving destination positions, rejection of mismatched `account`).

Not ready to merge after A6. The remaining gap still violates D86 through an actual in-app export path; documenting it does not resolve the blocker.
