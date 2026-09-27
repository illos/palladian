# 02 — User behavior

## Launch and readiness

Confirmed: displaying previously downloaded notes must not wait for authentication or a server response. Proposed implementation sequence:

1. Load the locally available shell, theme, navigation state, and account-scoped note-list snapshot.
2. Display titles and previews from a small local index without scanning or decoding every document.
3. Open a cached note using its local content. Fetch uncached content only when necessary; first-ever downloads cannot be instantaneous.
4. Establish session and live connection in parallel with local display.
5. Refresh snapshots from accepted server state without blanking the screen, losing scroll position, or moving the cursor unexpectedly.
6. Initialize rich viewers and agent UI independently when used.

Proposed: list metadata for the library is retained locally; bodies and attachment previews download in the background under a visible storage policy. Whether all text bodies are automatically retained is Q04. Cache completion must be observable; a record of a note is not proof its body/files are present. Handle storage failure/eviction without treating missing local state as a server deletion.

## Display versus editing

**Open Q03:** may the app briefly wait to enable editing while showing cached content immediately?

Proposed default: cached content is readable/selectable immediately; shared editing begins after current permission, document version, and active claims are established. Once ready, keystrokes render locally without waiting for a server acknowledgement per character.

| Condition                             | Proposed behavior                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Returning device, connection starting | Display account-scoped cached notes; permit navigation, selection, and copying                                                     |
| Session and document ready            | Enable ordinary editing and live collaboration                                                                                     |
| New device or missing content         | Show a useful local shell and a scoped loading state for unavailable content                                                       |
| Temporary disconnection               | Keep content visible, preserve in-flight edits, show unobtrusive reconnecting status; pause new shared edits once loss is detected |
| Confirmed expired/revoked session     | Request sign-in for remote work; preserve a recoverable private draft                                                              |
| Explicit logout/account switch        | Clear the prior account's visible data and private caches before another account appears; settle unsaved-work handling explicitly  |
| Broken embed or agent failure         | Isolate the failure; ordinary text and navigation remain usable                                                                    |

Instant typing before live readiness is a different requirement from instant display. If chosen, specify buffering and reconciliation explicitly; do not smuggle a full offline editor into startup.

## Editor

Confirmed experience: continuous formatted writing, with specialized embedded objects. Internal stable IDs must not split ordinary paragraphs into isolated text boxes.

Proposed initial formats: paragraphs, headings, bold/italic/strikethrough, links, ordered/unordered lists, checklists, quotes, code, images, and file attachments. Tables and advanced embeds require Q05. No formula, diagram, board, or Deck subsystem is automatically inherited from Deltos.

Acceptance includes cross-paragraph selection on an actual iPhone, mixed-content copying/pasting, selection across formatting, predictable Enter/Backspace, undo/redo, composition input, and moving around embeds without trapping the cursor.

Markdown is a convenient input/export representation, not necessarily the canonical stored document. Proposed shortcuts:

| Input                                          | Result                                           |
| ---------------------------------------------- | ------------------------------------------------ |
| `#HEADER` then Tab at a paragraph start        | H1 containing `HEADER` — confirmed exact example |
| `# `, `## `, `### `                            | Heading levels 1–3                               |
| `- ` or `* `                                   | Bullet list                                      |
| `1. `                                          | Ordered list                                     |
| `[ ] `                                         | Checklist                                        |
| `> `                                           | Quote                                            |
| Three backticks followed by Enter              | Code block                                       |
| Paired bold, italic, or inline-code delimiters | Corresponding inline formatting                  |

Proposed: immediate Undo reverses a shortcut transformation and restores literal input. Shortcuts do not execute in code. Toolbar actions and shortcuts invoke the same editor commands. Markdown export defines explicit fallbacks for unsupported rich objects; it must not silently discard them. Pasting markup/HTML must sanitize unsafe content.

## Organization and search

Confirmed: a notebook is a library of notes, private by default. Each note belongs to one notebook at a time. First-release accounts are the owner plus invited collaborators.

Collections are separate saved queries that display notes matching criteria such as search text, title, date, and location. Users can create collections, and every user starts with one default collection, **All notes**, including both notes they own and notes shared with them. Matching is dynamic: edits to a note or its relevant metadata can change which collections display it. A note can appear in multiple collections without being copied or moved. Collections cannot be shared or published to other users. They are available to MCP agents in the associated user context and have no independent permission controls. Results, counts, and previews respect the requesting user or agent's notebook permissions and any note-level overrides; matching a query never grants additional access.

Proposed: cache collection definitions and evaluate supported queries against cached metadata/text immediately; make any partial/offline result scope clear. Server results refresh independently of initial display. Query fields/operators, date meanings/timezones, source and consent for location metadata, and archive/trash inclusion in All notes and other collections remain Q05. A location filter does not itself authorize automatic device-location collection.

Proposed supporting features: pinned notes, archive/trash, and text search. Notebook ownership transfer, nesting, tags, title placement, and default sorting remain Q05/Q06.

Cached title/preview search can respond immediately. Server full-text search provides authorized results across accepted content. If local search covers only cached content, the UI states that scope. Agent reads for editing resolve current authoritative content, not an old search excerpt.

## Sharing and publishing

Confirmed: every notebook and every note has a permissions manifest supporting:

- Private.
- Private with access for invited members. A member is another user or an individual AI agent; each invited member can read only or edit.
- Public: anyone with the URL can read it. Editing requires invited membership with edit permission. This does not authorize public account signup.

Notebook permissions provide defaults; explicit individual note permissions override them. A private note inside a shared/public notebook remains private; a note can be shared independently from a private notebook. Notebook listing and search must respect the effective note permissions.

Confirmed: public links show the latest saved content automatically. Once a note is public, subsequent accepted edits become visible without another publish action. Public notebook views likewise reflect current saved content, subject to each note's effective permissions. Unsaved local work is not public content. This supersedes the earlier proposed fixed-revision publication default; a separate snapshot-publishing feature is not required for the first release.

Confirmed: public visitors and invited read-only members see only current content. Viewing version history requires effective edit permission, for both users and individual agents. This includes listing revisions, reading past content, and comparing versions.

Public visitors remain read-only. Making private content public is still an explicit permission change; saving an already-public note updates its public content. Confirmed: only the owner can invite members or change sharing permissions, including member roles and public/private visibility. Edit permission alone does not grant these powers, whether the member is a user or an agent. Confirmed: a note created inside a notebook belongs to the notebook owner, regardless of which invited user or agent created it. History credits the actual creator; authorship does not confer ownership or permission administration. Open Q06: ownership transfer, moves between notebooks with different owners, and link expiry/indexing. Proposed defaults: links are revocable; public access includes current authorized attachments but excludes agent conversation. Historical content is restricted to editors by the confirmed rule above.

## Files and embeds

Pictures, PDFs, and miscellaneous files are required. Proposed: private bytes in R2; authoritative ownership, references, and lifecycle in Convex. Pending/uploading/ready/failed states are distinct. Retrying an upload must not duplicate attachments. Failed or cancelled uploads are cleaned up without deleting referenced historical files.

Text renders independently of file download and preview generation. Embeds reserve predictable space or a compact placeholder. A download is not counted as available offline until its bytes are stored locally. Limits, full-resolution caching, PDF page rendering, malware handling, supported MIME types, and retention are Q04/Q05/Q11.

## Reminders

Reminders are required, but delivery is Q07: in-app, web push, email, or eventual native notifications. Define timezone, recurrence, snooze, late delivery, account/device targeting, and edit/delete cancellation before implementation. A server schedule alone is not proof that a phone receives a notification with the app closed.

## Agent collaboration

External MCP is a primary interface from the first usable agent milestone. The later sidebar should use the same domain operations and permissions. Agent authorship and history are visible; human takeover of a claimed section has a defined result. Model/provider choice, credentials, costs, execution hosting, and conversation retention remain Q12.
