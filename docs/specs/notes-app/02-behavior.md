# 02 — User behavior

## Launch and readiness

Confirmed: displaying previously downloaded notes must not wait for authentication or a server response. Proposed implementation sequence:

1. Load the locally available shell, theme, navigation state, and account-scoped note-list snapshot.
2. Display titles and previews from a small local index without scanning or decoding every document.
3. Open a cached note using its local content. Fetch uncached content only when necessary; first-ever downloads cannot be instantaneous.
4. Establish session and live connection in parallel with local display.
5. Refresh snapshots from accepted server state without blanking the screen, losing scroll position, or moving the cursor unexpectedly.
6. Initialize rich viewers and agent UI independently when used.

**Confirmed Q04:** automatically download and retain all current note text in the user's accessible library, including owned and shared notes. Pictures and PDFs load lazily when needed; text-cache population does not bulk-download their bytes.

Proposed implementation: retain list metadata and the document structure needed to render text locally. Populate and refresh the text cache incrementally in the background, prioritizing the active note; never wait for the whole library to download before displaying available notes or enabling ready online work. This is current-content caching, not a requirement to download every historical revision. Cache completion must be observable; a record of a note is not proof its body/files are present. Handle storage failure/eviction without treating missing local state as a server deletion. Keep account caches isolated. Once the app learns that access to a shared note has been revoked, remove its cached copy from normal viewing; transient network errors do not establish revocation.

## Display versus editing

**Confirmed Q03:** existing cached notes display immediately and may briefly remain read-only while the app connects and prepares live editing. Reading and navigation remain available throughout; no whole-screen loading gate.

Proposed readiness checks implementing this decision: cached content is readable/selectable immediately; shared editing begins after current permission, document version, and active claims are established. Once ready, keystrokes render locally without waiting for a server acknowledgement per character.

| Condition                             | Proposed behavior                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Returning device, connection starting | Display account-scoped cached notes; permit navigation, selection, and copying                                                     |
| Session and document ready            | Enable ordinary editing and live collaboration                                                                                     |
| New device or missing content         | Show a useful local shell and a scoped loading state for unavailable content                                                       |
| Temporary disconnection               | Keep content visible, preserve in-flight edits, show unobtrusive reconnecting status; pause new shared edits once loss is detected |
| Confirmed expired/revoked session     | Request sign-in for remote work; preserve a recoverable private draft                                                              |
| Explicit logout/account switch        | Clear the prior account's visible data and private caches before another account appears; settle unsaved-work handling explicitly  |
| Broken embed or agent failure         | Isolate the failure; ordinary text and navigation remain usable                                                                    |

Confirmed: explicit sign-out removes the signed-out account's cached note content and downloaded attachments from app-managed storage on that device. Cached metadata, previews, search indexes, and in-memory content must not expose that account afterward. This does not delete server notes or user-exported files outside app-managed storage. Transient connection/auth failures are not explicit sign-out.

Confirmed: v1 relies on the device lock and has no separate app-unlock step. When signing out with unsynced edits, offer to wait for saving, export the edits, or explicitly discard them before clearing local data. A failed save or cancelled export must not count as resolving the pending work. Signing out must not silently discard its only copy.

Confirmed: remove a shared note's cached copy once its access revocation is known. Proposed cleanup includes body, title/preview, indexes, historical snapshots, in-memory views, and attachment bytes accessible only through that revoked note; objects still accessible through another authorized note retain their valid cache. Prevent late responses from restoring revoked content. Pending-edit recovery after access loss and account/session revocation handling remain Q13.

Typing into an existing cached note before live readiness is not required for the first release. Keep any later offline-edit adapter separate from startup. A brief readiness wait is acceptable; its performance budget still needs Q10 and actual-device evidence. This decision does not specify new-note creation while connecting.

## Editor

Confirmed: the first line of a note is automatically its title; there is no independent editable title field. Editing that line updates the displayed title. Proposed: derive the title from the first logical line, independent of viewport wrapping, and keep list/search/cache projections aligned with the note revision. Empty or non-text first-line display rules remain to be specified.

Confirmed experience: continuous formatted writing, with specialized embedded objects. Internal stable IDs must not split ordinary paragraphs into isolated text boxes.

Confirmed v1 formats: paragraphs, headings, bold/italic/strikethrough, links, ordered/unordered lists, checklists, quotes, code, images, and file attachments. Confirmed: editable tables are outside v1, with no later release assigned. Advanced embed scope remains Q05. No formula, diagram, board, or Deck subsystem is automatically inherited from Deltos.

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

Confirmed: a notebook is a library of notes, private by default. Notebooks form a flat list and never nest. Folders are outside the first release; any future folder feature must preserve the rule that a notebook cannot contain another notebook. Each note belongs to one notebook at a time. First-release accounts are the owner plus invited collaborators.

Collections are separate saved queries that display notes matching criteria such as search text, title, date, and location. Users can create collections, and every user starts with one default collection, **All notes**, including both notes they own and notes shared with them. Matching is dynamic: edits to a note or its relevant metadata can change which collections display it. A note can appear in multiple collections without being copied or moved. Collections cannot be shared or published to other users. They are available to MCP agents in the associated user context and have no independent permission controls. Results, counts, and previews respect the requesting user or agent's notebook permissions and any note-level overrides; matching a query never grants additional access.

Proposed: cache collection definitions and evaluate supported queries against cached metadata/text immediately; make any partial/offline result scope clear. Server results refresh independently of initial display. Confirmed v1 filter fields: text, title, notebook, creation date, last-edited date, and location. Exact operators, date boundaries/timezones, and location matching semantics remain Q05.

Confirmed: Trash acts as a special collection of trashed items. It is not a notebook destination and does not change a note's notebook or ownership. Proposed: show trashed notes there and exclude them from All notes and ordinary collection results by default. Collection access does not expand trash/restore/permanent-delete permissions.

Confirmed: the app asks for location access and stores location with the note so it can be searched or used in collections in v1. Proposed representation: structured note metadata, rather than adding visible text to the body. Permission prompts and location lookup must not delay launch, cached display, or navigation. Confirmed: capture once at note creation, without updating location on subsequent edits. Stored location is visible only to the note owner, including for shared or public notes. Do not expose it through collaborator/public reads, history, search excerpts, or location-filter matches. Confirmed: notes work normally if location permission is denied or location is unavailable; creation, editing, saving, and non-location search remain available with location absent. Precision and manual correction remain Q05; explicit owner-delegated agent access remains Q14.

Confirmed: Trash retention is a user setting, allowing the user to choose whether deleted notes remain until manually emptied or are permanently deleted after a retention period. The default is automatic permanent deletion after 30 days in Trash. Other available periods remain Q11. Confirmed: editors may move shared notes to Trash and restore them; only the note owner may manually delete them permanently. Automatic deletion still follows the configured retention policy. The note owner's Trash retention setting governs shared notes, regardless of which collaborator moves them to Trash.

Confirmed: no tags in v1. Note lists default to most recently edited first; other sorting options come later. This applies to notebook lists of notes and collection results. The exact edit timestamp/tie-breaking semantics remain an engineering contract to specify.

Confirmed: no pinning or separate archive feature in v1. Users can move notes between notebooks. A user wanting an archive creates a normal notebook and moves notes there; it has ordinary notebook permissions and does not automatically hide its notes from All notes. Confirmed: only the owner can move notes, and v1 moves are restricted to notebooks with that same owner. Notes inherit the destination notebook's permissions unless explicit note-level permissions already exist; preserve those overrides. Before moving out of a shared space, warn when collaborators will lose access. Base the warning on effective access after applying overrides, rather than assuming every move revokes access. Ownership transfers are deferred beyond v1. Text search is part of the notes flow.

Cached title/preview search can respond immediately. Server full-text search provides authorized results across accepted content. If local search covers only cached content, the UI states that scope. Agent reads for editing resolve current authoritative content, not an old search excerpt.

## Sharing and publishing

Confirmed: every notebook and every note has a permissions manifest supporting:

- Private.
- Private with access for invited members. A member is another user or an individual AI agent; each invited member can read only or edit.
- Public: anyone with the URL can read it. Editing requires invited membership with edit permission. This does not authorize public account signup.

Notebook permissions provide defaults; explicit individual note permissions override them. A private note inside a shared/public notebook remains private; a note can be shared independently from a private notebook. Notebook listing and search must respect the effective note permissions.

Confirmed: public links show the latest saved content automatically. Once a note is public, subsequent accepted edits become visible without another publish action. Public notebook views likewise reflect current saved content, subject to each note's effective permissions. Unsaved local work is not public content. This supersedes the earlier proposed fixed-revision publication default; a separate snapshot-publishing feature is not required for the first release.

Confirmed: public visitors and invited read-only members see only current content. Viewing version history requires effective edit permission, for both users and individual agents. This includes listing revisions, reading past content, and comparing versions. Confirmed: retain edit history for as long as the note exists, including while it is in Trash; historical versions do not expire after a retention window.

Public visitors remain read-only. Making private content public is still an explicit permission change; saving an already-public note updates its public content. Confirmed: only the owner can invite members or change sharing permissions, including member roles and public/private visibility. Edit permission alone does not grant these powers, whether the member is a user or an agent. Confirmed: a note created inside a notebook belongs to the notebook owner, regardless of which invited user or agent created it. History credits the actual creator; authorship does not confer ownership or permission administration. Ownership transfer and cross-owner moves are outside v1. Confirmed: owners may replace a public URL, invalidating the previous URL. Public notes and notebook pages are indexable by default. Open Q06: optional link expiry. Proposed: public access includes current authorized attachments but excludes agent conversation. Historical content is restricted to editors by the confirmed rule above.

Confirmed: moving a public note to Trash immediately makes its public link unavailable. Public notebook listings must also exclude trashed notes. Restoring the note automatically re-enables the same current public link if effective permissions still make the note public. Restoration must not reactivate a URL invalidated by an earlier link replacement or override a change to private visibility.

## Files and embeds

Pictures, PDFs, and miscellaneous files are required. Proposed: private bytes in R2; authoritative ownership, references, and lifecycle in Convex. Pending/uploading/ready/failed states are distinct. Retrying an upload must not duplicate attachments. Failed or cancelled uploads are cleaned up without deleting successfully finalized objects outside their lifecycle policy.

Confirmed: images, PDFs, and other attached files are separate objects; notes contain references to them, not the object bytes themselves. Upload an object once and reuse its reference across note revisions; saving or restoring a note does not create another copy of the uploaded file. Uploaded objects, including document files, have no version history of their own; notes retain their separate edit history. Deleting an attached object moves that object to Trash under the same configured Trash retention policy (30 days by default, with manual-only retention available). Restoring a note version that references a still-trashed object restores that object to active use with the note. Historical references do not keep deleted object bytes forever: objects remain subject to Trash retention. Confirmed: if an object has already been permanently deleted, restoring a note version displays an “attachment permanently deleted” placeholder at its reference. Removing one reference leaves the object active while another active note still references it. An object enters Trash when its last current reference in active notes is removed. Moving a whole note to Trash also immediately trashes its objects that no other active note uses. Object ownership across different owners and permanent note-deletion cleanup details remain Q11.

Confirmed: pictures and PDFs lazy-load when needed. Proposed: apply the same on-demand policy to miscellaneous file bytes. Text renders independently of file download and preview generation. Embeds reserve predictable space or a compact placeholder. A download is not counted as available offline until its bytes are stored locally. Limits, media-cache retention after loading, explicit offline attachment downloads, PDF page rendering, malware handling, and supported MIME types remain Q05/Q11.

## Reminders — v2 target

Confirmed: reminders target v2 and are outside the first usable release. Delivery remains a deferred Q07 decision: in-app, web push, email, or eventual native notifications. Define timezone, recurrence, snooze, late delivery, account/device targeting, and edit/delete cancellation before implementation. A server schedule alone is not proof that a phone receives a notification with the app closed.

## Agent collaboration

Confirmed: agents claim only the content needed for their work, expanding across multiple paragraphs when necessary without claiming unrelated paragraphs. Human editors can cancel an agent claim and resume editing; the agent must be alerted that its edit was interrupted. Authorized agents edit directly by default, with history supporting review, correction, and recovery instead of a mandatory approval queue.

Confirmed: MCP exposes note history so an authorized editor agent can move backward and forward through revisions, inspect earlier content, compare changes, and restore content. This uses the same editor-only history permissions as the app.

Confirmed: external MCP agent access ships in v1; the in-app chat sidebar is deferred to a later release. The later sidebar should use the same domain operations and permissions. Agent authorship and history are visible; human takeover of a claimed section has a defined result. Model/provider choice, credentials, costs, execution hosting, and conversation retention remain Q12.
