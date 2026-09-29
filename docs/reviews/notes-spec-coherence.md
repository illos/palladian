# Notes specification coherence review

Date: 2026-09-29. Scope: the seven files in `docs/specs/notes-app/`, checked against the recorded owner discussion and D01–D90. Documentation review only; no application, service, browser, MCP-client, or iPhone acceptance was performed.

## Corrections

- Applied explicit trusted-agent delegation consistently to sharing, notebook moves, and manual permanent deletion. Ordinary edit membership still grants no owner authority; public-URL replacement retains its separately specified owner requirement.
- Separated ordinary session expiry, transient failure, voluntary logout, device revocation, effective note-access loss, and permanent deletion. Ordinary recovery cannot override revoked access or resurrect permanently deleted notes. Explicit note overrides remain relevant when notebook membership changes.
- Removed stale claims that privacy, retention choices, device selection, empty titles, or the app domain were undecided. Marked automatic location capture separately from allowed manual changes/removal.
- Preserved lifetime note history while the note exists, with permanent deletion ending that lifetime. Kept uploaded objects unversioned and independently retained; history does not pin deleted object bytes.
- Distinguished ordinary collections including Trash from public notebook listings excluding it. Kept history restricted to editors and location available to authorized agents while restricted for other human collaborators/public visitors.
- Removed a conflict-copy default that could assign a submitting collaborator ownership inside someone else's notebook. Recovery placement is now explicitly unresolved rather than contradicting notebook ownership.
- Marked mobile space shortcuts and other implementation details as proposals. Clearly excluded v2 reminders and later offline-edit tests from v1 acceptance.
- Consolidated repeated acceptance additions into a grouped proof checklist, preserved all decision/question/acceptance IDs, and documented which file owns each detailed contract.

## Remaining contracts

Q02/Q05 cover release consolidation and remaining product details. Q10/Q14 and G01–G05 require engineering evidence. Q11 still covers cross-owner objects, cleanup when other trashed notes reference an object, quotas, and authorized recovery placement. A shortening warning, original-Trash-entry deadline calculation, physical purge, and backup expiry remain explicit proposals/contracts; the review does not promote them to owner decisions. Sidebar, reminders, and actual import remain later or separately assigned scopes.

The working documents have no identified conflicting current owner decisions after these corrections. The ledger retains historical decisions with their later qualifications. Technical links remain discussion-time references to recheck at implementation.

## Validation

Checked Markdown formatting, whitespace, local file links/section anchors, and preservation of D01–D90 and A01–A21. Reviewed the diff for accidental feature loss and confirmed/proposed status changes. Runtime and integration checks remain pending.
