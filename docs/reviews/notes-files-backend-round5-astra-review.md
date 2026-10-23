# Files backend (B1, B2): independent review, round 5

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only. Reviewed `0042ef8..63d5619` on `feat/notes-files-backend`. Result: changes needed, two blocking findings.

Responses: "Review round 5 responses" in [notes-files-backend-implementation.md](notes-files-backend-implementation.md).

---

1. **R5-1 — blocking: An existing attachment image bypasses the new-file compatibility gate.** [attachments.ts:108] combines images and file blocks into one object-ID set; [line 129] therefore permits a new `file` block whenever an image references that ID. Local backend reproduction: seed an image accepted by the actual `0042ef8` schema, leave the gate off throughout, then append a file block referencing its ID. The edit succeeds, but the old schema now throws **"Unknown node type: file."** No object or upload is needed, and the compatibility scan reports nothing. **Fix:** distinguish existing file blocks from attachment images in both server and client feature comparisons, including named-source copies. Add this pre-B2 regression.

2. **R5-2 — blocking: Cut-and-paste silently loses existing attachments while gated.** [editor-clipboard.ts:356] compares against the document _after the cut_. Cutting the sole file block therefore makes its subsequent paste become filename text. The [undo gate] (file-capability.ts:58) also prevents restoring it. Both reproduced locally with real ProseMirror state. The [move test] (files-gate.test.ts:304) covers copying followed by an atomic drag move, not cut-and-paste. **Fix:** preserve same-note cut recovery under an explicit, matching server/client policy, or prevent the destructive cut with an explanation. Test separate cut/paste transactions, an acknowledged deletion, and undo recovery.

3. **R5-3 — should fix: HTML copying drops existing HTTPS-image widths even with files enabled.** [schema.ts:290] retains parsed widths only for `attachment:` sources. Local serialization/parsing reproduction: the app emits its own HTTPS image with `width="300"` and parses it back with `width: null`. This occurs before the preservation filter; direct-slice tests miss it. **Fix:** preserve validated widths for the app's own serialized images, then apply the capability filter. Add an actual HTML clipboard round-trip regression.

Other checks found no forged-source authorization bypass or width transfer onto a different image source. Ordinary text undo and remote collaboration passed. `files.capabilities` safely exposes one boolean, including to authenticated agents, not only people. Agents need no additional capability tool for correctness; correct that documentation. The documented refusal races remain real, and their "only after enabling files" qualification overlooks pre-B2 attachment images.
