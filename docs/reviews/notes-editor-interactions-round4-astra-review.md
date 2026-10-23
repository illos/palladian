# Editor interactions — independent review, round 4

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `f9f4835..dedc59e` on `feat/notes-editor-interactions` (before the branch was rebased onto `5211e06`). Report recorded verbatim below; responses are in `notes-editor-interactions-implementation.md`.

---

1. **R4-1 — should fix: Apply does not revalidate the mapped target's eligibility for a link.** Opening rejects code and cross-block selections at [editor-links.ts:240], but [Apply:285] checks only content and `touched`.

   Reproduced through `receiveTransaction`: open on `bcde` in paragraph `abcdef`; remotely convert that paragraph to code. Content equality remains true and `touched` false. Apply with label `Greeting` produces code `aGreetingf`, **without a link**. Unedited Apply silently does nothing.

   Also reproduced: remotely split the target across paragraphs, attempt edited Apply, then follow the [reload path:934 in editor.tsx]. Editing the refreshed label and applying merges the paragraphs, although opening a form on that selection is prohibited. Both reproductions pass `applySafeStep`.

   **Fix:** Recheck the mapped range's same-parent, code and mark eligibility before Apply and after reload. Close or invalidate an ineligible target without modifying it. Add both collaboration regressions.

The round-3 content guard otherwise passed independent probes: identical-text replacement and delete/reinsert, mark-only changes, inline-node changes, block splits on first Apply, and composition-tagged replacements. Nonempty unedited Apply preserved text, nodes and unrelated marks. No other rounds 1–2 regression surfaced.
