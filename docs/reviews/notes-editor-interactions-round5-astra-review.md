# Editor interactions — independent review, round 5

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `5211e06..60abf7c` on `feat/notes-editor-interactions` (before the branch was rebased onto `b095f8c`). Report recorded verbatim below; responses are in `notes-editor-interactions-implementation.md`.

---

1. **R5-1 — should fix: Pending inline-code formatting bypasses link eligibility.** [editor-links.ts:244] checks document marks but ignores `state.storedMarks`. [applyLink:311] then inherits those marks when inserting text.

   Reproduced in Chromium: type `abc`, toggle **Inline code** at the caret, open **Link**, enter text `Site` and address `example.com`, then Apply. The form closes and produces `abc<code>Site</code>` with **no link**. An independent editor-state test reproduced this; every emitted step passes server validation.

   **Fix:** Include pending insertion marks in eligibility checks at opening and Apply, and reject inline-code insertion consistently. Add this regression. The two reported round-4 remote-change cases are fixed.

2. **R5-2 — note: Rebase and A2 integration checks passed.** Byte comparison confirms `styles.css` is exactly main's CSS followed by the original A3 additions and round-4 CSS, with no nested rules. Duplicate/Export/Print still get current editor content; Trash closes the note before the mutation; toolbar, menu and swipe tests passed.
