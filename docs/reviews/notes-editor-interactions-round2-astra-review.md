# Editor interactions — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `e938f77..ba92c8e` on `feat/notes-editor-interactions`. Report recorded verbatim below; responses are in `notes-editor-interactions-implementation.md`.

---

CHANGES NEEDED

1. **R2-1 — should fix: Rebasing loses the link form's target.** [editor-links.ts:318] maps endpoints through individual `StepMap`s, losing ProseMirror's mirror recovery across rollback/reapply pairs. Reproduced: insert unconfirmed `hello` into `say  there`, open the form on it, then receive an unrelated remote prefix. The full transaction mapping preserves `[9,14]`; this plugin collapses it to `[14,14]`. Apply reloads an empty label; applying again produces `Oh, say hellohttps://e.com there`. **Fix:** Preserve mirror-aware endpoint mapping and distinguish rebase bookkeeping from actual overlapping edits. Add pending-local-step tests; the new tests at [editor-interactions.test.ts:1122] receive remote changes without unconfirmed local steps.

2. **R2-2 — should fix: Paste preprocessing can freeze the editor.** The adjacent whitespace repetitions in `FENCE` at [editor-clipboard.ts:55] cause quadratic backtracking. It runs before the indentation exclusion. Reproduced through `markdownSlice` with `**x**\n` followed by 64,000 spaces and `code`: **4.5 seconds**, versus approximately **1 ms** for the unchanged parser. This is well below the 500,000-character input limit. **Fix:** Scan indentation/container prefixes without overlapping whitespace quantifiers. Add a large-whitespace regression.

3. **R2-3 — should fix: The comparison still permits literal-character loss.** [editor-clipboard.ts:119] checks only raw input for U+E000. Markdown entities can introduce it during parsing. Reproduced `**a**&#xE000;b\nnext` and the decimal equivalent: the comparison passes, then [splitLines:144] deletes the literal character and creates three paragraphs. **Fix:** Check the unchanged parsed content for marker collisions, or preserve line boundaries without textual sentinels. Test both numeric-entity forms.

Other checks: F2 is correct for the reviewed boundary cases; its tests replay every emitted step, including ID repairs, through `applySafeStep`. Local undo and composition-tagged replacement probes detected overlaps. Note switching clears the form through editor cleanup and the keyed parent.
