# Editor interactions — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed `ba92c8e..f9f4835` on `feat/notes-editor-interactions`. Report recorded verbatim below; responses are in `notes-editor-interactions-implementation.md`.

---

1. **R3-1 — blocking: Rebased link forms can still overwrite collaborators' text.** In [editor-links.ts:315], the prefix mapping cannot recover endpoints whose mirror replay occurs later. An insertion can therefore appear outside the range during overlap detection but inside its final mapped range.

   Reproduced using actual `receiveTransaction`: start with `abcdef`; locally replace `a` with `XYZ`; open the form on `YZb`; receive a remote insertion of `REMOTE` between original `a` and `b`. The target becomes `YZREMOTEb`, but `touched` remains false. Applying edited label `Greeting` produces `XGreetingcdef`, deleting the collaborator's text. Every resulting step passes `applySafeStep`.

   Also reproduced with a **partially replayed replacement**: replace `abc` with `XYZ`, select `YZd`, then receive deletion of `b` and insertion after `c`. The same loss occurs. The [round-2 tests:1338] cover pending insertions, but not these replacement-boundary cases.

   **Fix:** Keep full mirror-aware mapping, but additionally invalidate the form when its original target content differs from the final mapped content. Add both reproductions and assert that applying an edited label is refused.

2. **R3-2 — note: Fence recognition remains approximate.** [editor-clipboard.ts:69] misses quote-inside-list and multiple-list prefixes, ignores indentation limits, and accepts backtick-containing info strings that the parser rejects. It also does not track implicit fence closure at container boundaries. This can suppress ordinary line preservation after code. The comparison at [editor-clipboard.ts:154] preserved exact code contents in all 14 local fence probes, including nested containers, both markers, and invalid closing indentation. **Fix:** Document the heuristic and add these fallback cases; use parser source ranges if complete line-preservation behavior is required.

R2-2's performance fix and R2-3's entity fix passed independent probes. Mapped-away insertion, history undo/redo after rebasing, and composition-tagged replacement probes correctly detected overlap.
