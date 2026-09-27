# 04 — Documents, collaboration, and history

## Authority and representation

Confirmed direction: the server owns the accepted shared document. Local snapshots display accepted content quickly. Later offline edits carry their starting revision and may become separate copies on conflict.

Proposed representation: a versioned rich-text document with stable IDs for addressable paragraphs, headings, list structures, and embeds. IDs are internal targeting aids, not separate text boxes. Splitting, joining, copying, and moving content need deterministic identity rules. A title is distinct metadata or a distinguished node; choose one canonical representation under Q05.

Markdown, plain text, outlines, previews, and search text are projections or import/export forms. Agents must not replace rich documents with a lossy Markdown round trip when editing a small region. Unknown rich objects remain preserved and discoverable through a readable description and stable reference.

## Notebooks and collections

Confirmed: a note has one notebook at a time. Notebooks never nest; no parent-notebook relationship is part of the model. Folders are a separate possible later feature with no first-release representation. Collections select notes programmatically through saved queries; they do not provide additional notebook memberships or permission inheritance. Every user has a default All notes collection covering owned notes and notes shared with them, and can create more. Collections are personal and not shareable/publishable to other users, but visible through MCP in the associated user context. They have no permission manifest or independent membership list; note access is governed by notebook permissions and note-level overrides.

Proposed representation: a collection stores its user association, name, and a versioned structured query definition. Its matching note IDs are derived results, not ownership records. Filters cover agreed text/title/date/location semantics. Validate supported query fields and operators; a saved query is not executable user code. Apply authorization before exposing matches, counts, or excerpts. Exact metadata and query semantics remain Q05.

## Proposed logical records

These are conceptual records, not a finalized database schema.

Confirmed: notes created in a notebook belong to the notebook owner. Record the creating user or agent separately as authorship/provenance; do not assign ownership from the actor who submits creation. Ownership transfer and cross-owner notebook moves remain Q06.

| Record                  | Essential meaning                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                 | Stable identity independent of login provider                                                                                                                        |
| Notebook                | Library of notes with its own permissions manifest, private by default                                                                                               |
| Collection              | User-associated saved query/name; personal, MCP-visible, no independent permissions; dynamic authorized results; default All notes                                   |
| Permission manifest     | Notebook or note visibility and invited user/individual-agent read/edit entries; explicit note preferences override notebook defaults                                |
| Agent identity          | Individually addressable agent member, distinct from its display name or provider label                                                                              |
| Membership/access grant | Which user or individual agent can access which notebook/note and with what rights                                                                                   |
| Note                    | Stable ID, single notebook ID, owner/access scope, creator attribution, title, current accepted revision, lifecycle state                                            |
| Revision                | Immutable ID, note ID, parent/base reference, schema version, authenticated actor, change provenance, device edit time, server receipt time, reconstructable content |
| Edit operation          | Stable request ID, expected revision/target versions, operation payload, result receipt                                                                              |
| Claim                   | Note/block targets, authenticated holder, generation, server expiry, lease status                                                                                    |
| File                    | Owner/access context, private storage key, media metadata, upload state, references                                                                                  |
| Public link             | Note/notebook URL resolving latest saved content under effective permissions; no fixed publication revision                                                          |
| Offline draft           | Local ID, original note/base revision, ordered local versions, device timestamps, synchronization status                                                             |
| Conflict link           | Original note/revision, incoming branch, recovered copy, resolution provenance                                                                                       |

Local timestamps are caller-supplied provenance, not authorization evidence. Actor identity is derived from the authenticated principal, never trusted from an arbitrary user ID argument.

## Online editing

Proposed: use a maintained centralized ProseMirror collaboration protocol to submit steps/transactions, order accepted changes, and rebase concurrent work. Do not implement whole-body last-writer-wins saving for live notes. Ordinary typed characters appear optimistically while connected; server acceptance determines durable shared save status.

An agent edit uses a known revision and stable targets. Unrelated concurrent edits should not force replacing the whole note. Exact rebase/target-version semantics must be proven in G02. Checking only the version fetched inside the save request does not protect against an agent writing stale content from an earlier read.

Recovery journal entries are removed only after acknowledgement. A timeout means the outcome may be unknown: retry with the same operation ID or look up its receipt before assuming failure. If accepted state has moved too far to replay pending edits safely, preserve a recoverable draft/copy instead of overwriting it.

## Agent paragraph checkout

Confirmed owner intent: an agent may claim part of a note; UI indicates the claim and prevents competing edits there until release. Proposed contract:

1. Claim acquisition is an atomic server operation against stable targets and current state.
2. Claims have short renewable leases using server time; expiry duration is an engineering default to test.
3. Connected editors show the holder and allow reading/copying claimed text. Structural edits crossing claimed content are subject to the same rule.
4. Server write validation checks actual affected content, permissions, and claim generation. UI disabling alone is insufficient.
5. A successful agent edit and claim release are committed together where the storage model permits atomicity.
6. Human takeover invalidates the previous generation. Late agent responses cannot commit with that claim.
7. In-flight human edits crossing a newly granted claim must receive a defined ordering/retry result and remain recoverable; they cannot disappear.
8. Agent research happens before claiming where practical, minimizing time spent blocking writing.

G02 must determine whether the collaboration component exposes sufficient validation hooks. A supplied block ID does not prove an arbitrary document update affects only that block. Q09 settles granularity, takeover rights, and direct-edit versus suggestion defaults.

## History

Confirmed: history is foundational. Record device edit time for edits made on a device, separately from server receipt/acceptance time. Preserve the revision from which the edit was made. For server-hosted agents, the editing process records its edit time and the server independently records acceptance.

Confirmed: viewing history requires effective edit permission. Invited read-only members and public visitors see only current content; users and agents follow the same rule. Revision lists, past content, and comparisons must enforce this permission.

Proposed:

- Keep reconstructable history through snapshots plus changes or another verified bounded representation. Visible history groups related typing into useful checkpoints rather than exposing every keystroke as a separate item.
- Keep authorship and human/agent provenance. Current read access does not grant historical access; history requires effective edit permission as confirmed above.
- Restore creates a new current revision referring to the restored source; it does not erase subsequent history.
- A user can compare a version with its predecessor or the common base of two branches.
- Attachments needed by retained revisions remain recoverable. Blob garbage collection must respect history and publication references.
- Permanent deletion, retention, and compaction are Q11. Long-term history and temporary collaboration steps can have different retention policies, but discarded steps must not silently destroy recovery options.

## Later offline editing

This extension is deferred. Its reconciliation policy is confirmed in the discussion; detailed storage and UI remain proposed.

Example: online revisions `A -> B`; a device edits B offline to produce C. On reconnect:

- If the current accepted revision is still B, atomically accept C as its next revision after authorization/validation.
- If B also has an online descendant D, preserve D as current and materialize C as a separate conflict copy. Link both to B so the user can compare their changes.
- Use revision ancestry, not device timestamps, to decide whether another branch exists. Clock skew and delayed upload cannot decide a winner.
- Preserve intermediate offline history and device edit times when importing the branch. Do not pretend all offline work was authored at upload time.

The branch submission has a stable idempotency key. Comparing the base, accepting the branch, or creating its conflict copy must have an atomic, retry-safe result. Repeated reconnect attempts produce one recovered copy, not a new note each time.

Proposed default: the conflict copy is private to the submitting user, clearly named and linked to its origin. It is not automatically published or shared. User resolution produces a new revision and may archive the extra copy without losing its history.

If the original was deleted or access revoked, do not resurrect it or bypass authorization. Preserve recoverable local work and expose a deliberate recovery/export path; whether it may be saved as a new private server note is Q11/Q13. A missing retained base produces an explicit recovery/conflict state, never an unsafe overwrite.

This policy deliberately tolerates more conflict copies in exchange for a smaller offline subsystem. Online collaboration still uses its live protocol; the offline branch is not interposed on every online edit.
