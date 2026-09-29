# 05 — Identity and MCP

## Accounts and reliable sessions

**Confirmed:** the first release supports the owner plus invited collaborators, without public signup. Email/password sign-in, emailed password recovery through Cloudflare Email Service, and invitation acceptance that verifies the invited address are v1 requirements. Passkeys, magic-link sign-in, and two-factor authentication are deferred.

Better Auth with Convex is proposed, subject to G03. Required outcomes:

- Cached viewing never waits for session validation. Ordinary use does not require weekly sign-in; a year-scale sliding session with shorter-lived access tokens is a proposed configuration.
- One supported renewal path serves all features. Timeouts, disconnects, rate limits, and server errors cause bounded retry, not false revocation.
- Session expiry pauses authorized remote work and requests sign-in while preserving cached viewing and ordinary pending work.
- Device sessions and agent credentials are independent. Device failure does not disconnect agents.
- Late responses cannot restore cleared content, replace a newer login, or expose another account's data.

G03 must verify supported lifetimes, renewal, transport, origins, sleeping tabs, and real token expiry. Discussion references: [Better Auth sessions](https://better-auth.com/docs/concepts/session-management) and [Convex integration](https://labs.convex.dev/better-auth/framework-guides/react).

## Local privacy and recovery

**Confirmed:** v1 relies on device security, with no separate app unlock or additional app-level local encryption. Backend processing for search and authorized agents is allowed; v1 does not require end-to-end encryption that hides content from the backend.

| Event                                            | Confirmed behavior                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session expiry or transient auth/network failure | Cached notes stay viewable; remote work waits for valid auth; ordinary pending work is preserved                                                      |
| Voluntary logout                                 | Clear account-scoped app-managed note/attachment caches and derived views; first offer save, export, or explicit discard for accessible unsynced work |
| Learned remote device revocation                 | Clear that account's cached notes on the revoked device                                                                                               |
| Learned effective note-access loss               | Remove the affected cached note; no export of unsaved work after notebook access is removed                                                           |
| Permanent note deletion                          | Note and all edit history are deleted; no history restoration remains                                                                                 |

A failed save or cancelled export does not settle voluntary logout. Account switching isolates prior-account data before showing the next account. Cleanup does not delete server notes or files already exported outside app-managed storage. Disconnected devices cannot learn revocation or deletion until they reconnect; local snapshots never grant fresh server access.

**Proposed cleanup:** clear affected metadata, previews, indexes, historical snapshots, memory, and pending recovery content. Account revocation clears the account's app-managed attachment cache; note-level cleanup retains bytes still authorized through another note. Reject late responses, replay, export, and recovery copies for inaccessible or permanently deleted content. Evaluate explicit note overrides before concluding that notebook membership removal revokes a note. These exceptions take precedence over ordinary pending-work recovery. Password-reset revocation of other-device sessions follows the same device-revocation cleanup.

## Invitation and email verification

Confirmed: accepting an emailed invitation verifies that same invited email address, avoiding a second verification email. Normal sign-in remains email/password.

Proposed implementation: bind the invitation to its destination email, intended access, expiry, and one-time acceptance state. Verification applies only to that address. An expired, revoked, reused, or mismatched invitation must not verify another address or grant access. Invitation acceptance for an existing account must not become an account-takeover or password-replacement path. Prove the supported auth-library integration in G03 rather than directly bypassing verification. New users establish a password as part of account setup.

## Password recovery

Confirmed: the user requests a password-reset email and uses its link to set a new password. Cloudflare Email Service is the delivery provider. A successful password reset automatically signs out other devices; this is not an optional choice in v1. The reset flow asks the user whether to disconnect connected AI agents. Choosing to disconnect revokes that account's agent connections and requires reauthorization; choosing to keep them preserves their existing authorization. Other devices sign out in either case.

Proposed interaction: present an explicit keep/disconnect choice before submitting the new password. Do not silently infer the choice from an unanswered prompt. Apply the selected connection policy only when the password reset succeeds; do not change notebook/note membership permissions as a side effect.

Proposed implementation: use the auth library's supported reset lifecycle, with expiring, single-use reset tokens, rate-limited requests, and a response that does not reveal whether an email has an account. Keep reset tokens and links out of logs. Requesting a reset must not itself change a password or revoke sessions; invalid, expired, or failed resets must not trigger the successful-reset sign-out behavior. Other-device sessions must lose authorized server access and renewal after successful reset. Local cache and unsaved-work handling follow Q13 and the existing recovery contract; server revocation cannot erase a disconnected device immediately.

G03 requires actual delivery through the selected sender domain and a complete request → inbox → reset → sign-in check, plus expired/reused-link rejection, delivery-failure behavior, automatic other-device sign-out only after a successful reset, and both keep/disconnect agent choices. Cloudflare setup prerequisites are recorded in [architecture](03-architecture.md). No email or infrastructure changes are performed by this specification.

## Authorization

**Confirmed:** notebook defaults and explicit note overrides govern all content access. Notes belong to their notebook owner; creator attribution does not confer ownership. A private override can restrict a note in a shared/public notebook, and a note can be shared independently from a private notebook.

Agents are individually addressable collaborators selectable in sharing controls. Authentication identifies an agent but grants no private content by itself. There is no parallel MCP content ACL or connection-wide read/edit default.

| Capability                                                                  | Required authority                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Current content                                                             | Effective read access; public visitors read only current public content                                |
| Edit, browse/compare/restore history, trash/restore note                    | Effective edit access; restoration uses the proposed revision-safe contract below                      |
| Invite, change sharing, move between notebooks, manually permanently delete | Owner, or an agent explicitly delegated that named action; ordinary edit membership is insufficient    |
| Replace public URL                                                          | Owner authority; delegation of URL replacement has not been separately specified                       |
| Stored location                                                             | Owner and agents with effective note access; hidden from other human collaborators and public visitors |

Delegation uses the same ownership/permission authority while preserving agent attribution. Representation, selected operations, and revocation mechanics remain Q14. Agents cannot self-delegate or escalate permissions. Same-owner notebook moves preserve note overrides and warn about actual collaborator access loss. Public links follow [document 02](02-behavior.md#sharing-and-publishing); public attachments cannot bypass visibility, Trash, or invalidated-URL checks. Automatic Trash cleanup follows the note owner's retention setting and is separate from manual permissions.

**Proposed enforcement:** one server-owned authorization layer serves UI, MCP, search, history, files, and publication. Derive identity from authenticated credentials, scope search before returning matches/counts/excerpts, and recheck writes at commit time. Enforce location privacy in history, caches, projections, and search; normal content editing does not make restricted metadata public. Private file URLs carry no permanent credentials. A move preview uses a versioned precondition so its warning matches the committed change.

## MCP foundation

**Confirmed:** official MCP TypeScript SDK v2, targeting protocol `2026-07-28`. This is an SDK/protocol decision, not a manifest format. The owner reconfirmed the earlier modern-MCP direction for the notes app.

**Confirmed acceptance targets:** Codex CLI, Claude Code, Hermes, and Codex accessed over the CLI through Presidium. Exercise the Presidium invocation path separately; success in a standalone CLI does not establish that integration. Exact installed versions and authentication compatibility remain G04/Q14, with no client compatibility accepted yet.

Implement the supported modern transport deliberately; installing SDK v2 alone is not proof that legacy protocol handling is disabled. Any legacy adapter is separately justified by reproduced client incompatibility after reachability, auth, SDK configuration, and client opt-in issues are excluded. Do not claim compatibility with a client that has not been exercised.

Use current official SDK APIs at implementation time. [Official SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

MCP endpoints must work while the browser is closed. They access the current accepted server document and use the same domain operations as the UI. External agents and future in-app agents must not maintain parallel document models or bypass collaboration.

## Agent-facing document contract

Proposed small, coherent model:

- Notebooks: stable IDs, names, descriptions, permission manifests, effective access rights, and filing guidance.
- Collections: personal saved-query IDs, names, definitions, and authorized results in the associated user context; no sharing or independent permissions. Include matching Trash by default, following document 02. A collection is not a filing destination.
- Notes: stable ID, single notebook ID, title, metadata, accepted revision, outline, and document URL.
- Content: readable text/Markdown with stable section/block targets; typed references for rich objects.
- Revisions: explicit expected revision or target-version preconditions and compact committed receipts.

Creation accepts substantial Markdown in one request and converts it into native content. Title is derived from the first line; an agent renames a note by editing that line, not a separate title property. Targeted edits preserve untouched rich objects. The agent does not need to synthesize ProseMirror JSON or binary collaboration updates for ordinary tasks.

Confirmed: an agent runs Deltos import manually. Proposed: use authorized destination discovery, note creation, and upload/finalize/attach operations with stable source/request identifiers to make retries safe. Preserve supported formatting and object references; report unsupported content instead of silently dropping it. The source stays read-only, and existing source permissions/history do not automatically become new-app grants/history. Exact fidelity, mapping, source scope, and timing need the import task's contract; no import is executed here.

## Proposed tool surface

Names below are conceptual API names, not frozen wire schemas.

| Tool family    | Contract                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find notebooks | Resolve destination using IDs/names, description, and configured filing guidance                                                                    |
| Collections    | Discover/read personal saved queries through MCP; proposed create/update operations; list authorized matches; no collection sharing/permissions API |
| Search notes   | Ranked authorized excerpts, note IDs, matching section IDs, revision and pagination information                                                     |
| Read note      | Outline, selected sections, or full readable content; clear truncation/pagination; current revision for editing                                     |
| Create note    | Destination, Markdown/native supported content, optional metadata, stable request ID; title derives from the first content line                     |
| Edit note      | Bounded atomic batch of append/insert/replace/move/delete-content/metadata operations with explicit preconditions                                   |
| Attach file    | Upload/finalize/reference workflow; no whole-body rewrite; explicit size/type limits                                                                |
| History        | Browse revisions backward/forward, read/diff/restore; effective edit permission required; browsing never changes live content                       |
| Share/publish  | Visibility changes require owner authority or explicit agent delegation; URL replacement requires owner authority; ordinary save is separate        |
| Claim/release  | Claim only needed content; release/expiry; human-editor cancellation with agent-visible interruption and stale-write rejection                      |

Prefer stable target IDs; never assume a heading label is unique. Destructive operations state their effects clearly. A tool that saves a private note does not implicitly publish it. Once a note is public, accepted edits automatically update the content at its public URL; no separate publish call is needed. Share/publish changes visibility rather than freezing a revision. Unknown or unsupported blocks remain preserved and readable by description.

Confirmed: authorized agents make direct edits by default, with history for review and recovery. No mandatory proposal/approval phase is required for ordinary content edits. Owner-only administrative operations retain their separate authorization rules.

Proposed history API: paginated revision summaries with stable IDs, parent/order information, actor and timestamps; bounded revision reads and diffs; explicit restore using the expected current revision and an idempotency key. Let agents traverse both directions without downloading the whole history. Restore appends a new revision and preserves intervening history, existing attachment-object lifecycle rules, and concurrent-work checks.

Confirmed: human cancellation alerts the affected agent. Proposed transport: prompt notification for connected clients plus persistent claim/operation status and an explicit interrupted error for late writes. Verify delivery/observation in G04 instead of assuming every MCP client handles unsolicited notifications.

MCP results use schemas and compact receipts: operation ID, note ID, URL, accepted revision, affected IDs, status, and explicit warnings. Errors distinguish conflict, denied, invalid input, missing resource, transient failure, and uncertain operation outcome without leaking private content.

## Speed and safety of writes

Proposed benchmarks:

- A normal-sized conversation can be saved in one write once a destination/default is known; no per-paragraph call loop. Very large transcripts/files use an explicit bounded upload/import path.
- Search excerpts can answer simple questions without mandatory whole-note reads.
- Editing one section reads and sends that section rather than the full note.
- A bounded group of changes is validated and committed together. Reject the batch rather than silently partially applying it unless a separate bulk-import API explicitly declares partial outcomes.
- A successful receipt eliminates the need to read the full note merely to discover its URL or new revision.
- Repeating a logical write with the same request ID produces the same result even if JSON-RPC request IDs differ. Persist idempotency results for a defined retry window.
- Expected revisions come from the agent's read, not only a server read during the eventual save.

Search/index latency and asynchronous processing must not make an acknowledged note disappear from direct read. Return the accepted document revision; indicate whether derived search or preview work is still pending. Do not claim end-to-end agent speed solely from backend function timing: measure tool count, payload size, and task completion.

## Agent authentication and future sidebar

Confirmed: agent content access is controlled by notebook/note sharing, not a separate connection permission layer. Proposed: independently revocable authentication credentials per connection, bound to the individual collaborator identity; supported authorization discovery/authentication remains an engineering gate. Changes to effective content access must take effect without waiting for credentials to expire, while honoring explicit note overrides. PAT versus OAuth availability, identity registration, owner-delegation representation, and rate limits remain Q14. Do not assume Better Auth's OAuth packages are automatically compatible with the Convex adapter.

The future sidebar uses the same note operations, claims, and history. It adds conversation state and agent execution, not another persistence authority. Model providers, account credentials, billing, execution environment, and whether agent conversations are shared are Q12. Note contents are data; reading a note does not authorize instructions embedded within it.
