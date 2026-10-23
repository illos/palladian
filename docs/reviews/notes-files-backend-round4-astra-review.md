# Files backend (B1, B2): independent review, round 4

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only. Reviewed `0042ef8..e99458f` on `feat/notes-files-backend`.

Responses: "Review round 4 responses" in [notes-files-backend-implementation.md](notes-files-backend-implementation.md).

---

1. **R4-1 — blocking: Gate rejection freezes the note and can lose unrelated pending typing.** The gate returns `invalid` at [documents.ts:201]. [channel.ts:313] permanently blocks that channel, while [channel.ts:359] stops journaling blocked work. The app then disables editing. Local reproduction using the real channel and ProseMirror state, with a simulated gate response: paste an image with `{width=300}`, then type before the rejection arrives → **blocked, two pending steps, zero draft writes**. Closing can lose both changes. The existing gate tests exercise backend rejection, not this interaction. **Fix:** prevent gated content entering local transactions while disabled, preserve pending work on capability rejection, and provide recovery without blocking unrelated typing. Test paste, concurrent typing, rejection, and reopening.

2. **R4-2 — note: The gate-off rollback documentation understates editing restrictions.** [attachments.ts:71] examines replacement slices, regardless of whether their attachments already exist. An actual backend test showed that changing only text through `replace_all`, retaining the identical file block, returns `invalid`; targeted `replace_text` succeeds. This qualifies the "edits that add none … are unaffected" statement at [implementation report:159]. **Fix:** document these restrictions, the disable procedure, and that compatible readers must remain deployed after disabling; add a rollback regression covering existing attachments.

R3-1 and R3-2 appear correctly fixed. No gate bypass found in the inspected paths: pushes, conflict copies, Markdown creation, agent operations, history restore, imports, or Duplicate. The staged client-upgrade prerequisite addresses old-reader compatibility, but R4-1 prevents acceptance for gate-off deployment.
