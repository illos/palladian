# Note history (A4) — round 5 independent review

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-23. Reviewed `df0db7e..813dad2` on `feat/notes-history`.

Recorded as relayed by the owner's coordinator ("Verbatim summary"); the coordinator's decision that followed it is under Design change after review round 5 in `notes-history-implementation.md`.

---

Round 5 of the A4 review (`df0db7e..813dad2`) came back CHANGES NEEDED with four more blocking findings in the restore keeper. Verbatim summary:

- **R5-1:** the 10-minute timeout releases editors before the restore arrives.
- **R5-2:** unreadable or lost storage permits editing.
- **R5-3:** another window's refusal erases an unresolved or applied restore.
- **R5-4:** expiry is not atomic.
- **R5-5:** a delayed sign-out can clear a newer account.
- **R5-6:** IndexedDB connection recovery is incomplete.
- **R5-7:** the `account` precondition and the `channel.ts` getter are sound; the D28 exception is unapproved.

In-place Restore cannot be made safe in app code alone: whole-document replacement dropping unsent typing is the fundamentals issue the owner hasn't approved fixing. **Decision: switch A4 to "Restore as a new note"** until a fundamentals fix exists.
