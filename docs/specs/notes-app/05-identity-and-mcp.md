# 05 — Identity and MCP

## Accounts and reliable sessions

**Confirmed Q01:** first usable release is for the owner plus invited collaborators. Public signup is outside that initial scope. Confirmed: notebooks contain notes and are private by default. Notebook and note permissions support private, invited-member, and public URL access. Invited members can be users or individual agents with read-only or edit access. Public visitors are read-only; public visibility never grants edit permission. Editing requires invited edit access. Explicit note permissions override notebook defaults. Only the owner can invite members or change sharing permissions. Notes created in a notebook belong to the notebook owner, including notes created by invited users or agents; creator attribution is separate. Ownership transfer and cross-owner moves are outside v1.

**Confirmed:** v1 sign-in uses email and password. Passkeys, magic-link sign-in, and two-factor authentication are later features, with no release number committed yet. The existing invitation-only account policy still applies. Accepting a valid emailed invitation verifies the invited email address; no separate verification email is required. V1 password recovery uses emailed password-reset links delivered through Cloudflare Email Service. This resets the password; magic-link sign-in remains deferred.

Better Auth is the preferred identity/session library. The v1 identity decisions are settled under Q08; local-cache privacy decisions are recorded under settled Q13; supported integration is G03. Do not inherit single-owner security exceptions from Deltos or copy the old app's session state machine.

Required outcomes from the owner's discussion:

- Cached note display does not wait for session validation.
- Ordinary use must not require weekly sign-in. Proposed configuration is a year-scale sliding device session with a shorter access-token lifetime where the integration requires one.
- Renewal has one supported owner. Editor, attachments, search, and app features do not independently rotate credentials.
- Timeout, disconnect, rate limit, or server error is not proof of revocation. Preserve credentials and retry with bounded backoff.
- Invalid sessions pause authorized remote work and offer sign-in; preserve unsaved work for ordinary expiry/retry, subject to explicit revocation cleanup. Confirmed: session expiry keeps cached notes viewable during that prompt; it does not trigger explicit-logout cleanup. Known note-access revocation still removes the affected cache; a remotely revoked device clears account-scoped cached notes once it learns of revocation.
- Device revocation and agent-grant revocation are separate operations. Device failure cannot revoke all agent connections.
- Explicit logout clears that account's app-managed cached notes and downloaded attachments on the device. Account switching isolates local state before displaying the next account; sign-out with unsynced work offers wait-for-save, export, or explicit discard before local cleanup.
- Late responses cannot overwrite a newer login, restore a signed-out session, or render the prior account's data.

Cached viewing entails retaining previously downloaded private content on the device. Offline revocation cannot instantly erase disconnected copies. Explicit logout clears app-managed note/attachment caches. Confirmed: v1 relies on the device lock; no separate app unlock. Known revocation of a shared note removes its cached copy, including derived views; a connectivity failure does not establish revocation. Sign-out with pending edits offers wait-for-save, export, or explicit discard before clearing local data. Confirmed: remotely revoked devices clear account-scoped cached notes once revocation is known. Users cannot export unsaved work after notebook access is removed. Device security is sufficient for local storage in v1; additional app-level encryption is not required. Proposed cleanup removes revoked content from recovery journals as well as display caches and prevents export, copying to a new note, and late replay. This supersedes ordinary recovery for inaccessible content, while explicit note overrides that preserve effective access still apply. Local snapshots never grant fresh server access.

Better Auth supports configurable lifetime and renewal intervals, but correct settings alone do not prove correct browser behavior. Test transport, origin, cookie/header handling, sleeping tabs, and real token expiry using the chosen version. See [session documentation](https://better-auth.com/docs/concepts/session-management) and [Convex integration](https://labs.convex.dev/better-auth/framework-guides/react).

## Invitation and email verification

Confirmed: accepting an emailed invitation verifies that same invited email address, avoiding a second verification email. Normal sign-in remains email/password.

Proposed implementation: bind the invitation to its destination email, intended access, expiry, and one-time acceptance state. Verification applies only to that address. An expired, revoked, reused, or mismatched invitation must not verify another address or grant access. Invitation acceptance for an existing account must not become an account-takeover or password-replacement path. Prove the supported auth-library integration in G03 rather than directly bypassing verification. New users establish a password as part of account setup.

## Password recovery

Confirmed: the user requests a password-reset email and uses its link to set a new password. Cloudflare Email Service is the delivery provider. A successful password reset automatically signs out other devices; this is not an optional choice in v1. The reset flow asks the user whether to disconnect connected AI agents. Choosing to disconnect revokes that account's agent connections and requires reauthorization; choosing to keep them preserves their existing authorization. Other devices sign out in either case.

Proposed interaction: present an explicit keep/disconnect choice before submitting the new password. Do not silently infer the choice from an unanswered prompt. Apply the selected connection policy only when the password reset succeeds; do not change notebook/note membership permissions as a side effect.

Proposed implementation: use the auth library's supported reset lifecycle, with expiring, single-use reset tokens, rate-limited requests, and a response that does not reveal whether an email has an account. Keep reset tokens and links out of logs. Requesting a reset must not itself change a password or revoke sessions; invalid, expired, or failed resets must not trigger the successful-reset sign-out behavior. Other-device sessions must lose authorized server access and renewal after successful reset. Local cache and unsaved-work handling follow Q13 and the existing recovery contract; server revocation cannot erase a disconnected device immediately.

G03 requires actual delivery through the selected sender domain and a complete request → inbox → reset → sign-in check, plus expired/reused-link rejection, delivery-failure behavior, automatic other-device sign-out only after a successful reset, and both keep/disconnect agent choices. Cloudflare setup prerequisites are recorded in [architecture](03-architecture.md). No email or infrastructure changes are performed by this specification.

## Authorization

Confirmed: authorization must represent individual agents as members, not just a blanket provider label such as Codex or Claude. Both notes and notebooks have permission manifests; explicit note settings take precedence over notebook defaults. The agent identity and credential-linking representation remains an implementation design, with connection authentication covered by Q14.

Confirmed: individual agents appear as potential collaborators in sharing controls. Notebook read/edit membership and note overrides determine their content access, with no parallel agent-specific permission system or connection-wide read-only default. Agent authentication identifies the collaborator; it does not itself grant private-note access.

Confirmed: the owner can explicitly authorize a trusted agent to publish, change sharing, move notes, or permanently delete. Treat those authorized actions as delegated owner authority while retaining agent authorship. Ordinary read/edit membership remains insufficient. Record the delegation through the same ownership/permission authority rather than a second MCP-only content ACL; exact representation, operation selection, and revocation mechanics remain Q14. Earlier owner-only rules permit this explicit trusted-agent delegation for the named operations.

Proposed: one server-owned authorization layer shared by editor operations, MCP, file access, search, history, and publication. Permission checks cover the effective note/notebook permissions, not just whether a caller is logged in. Notebook membership cannot bypass a more restrictive note override, including through listings, search excerpts, direct reads, files, or MCP.

Confirmed: effective edit access permits moving a shared note to Trash and restoring it. Manual permanent deletion requires note ownership; read-only/public access permits none of these operations. Apply the same checks to UI and MCP requests; an agent's edit membership does not grant owner powers. Automatic retention cleanup remains a separate lifecycle operation, not an editor permission. The note owner's Trash retention setting governs shared notes, regardless of which collaborator moves them to Trash.

The owner, or an agent explicitly delegated the relevant owner action, can administer invitations, change member roles, or change public/private visibility. Enforce this in UI and MCP operations; an invited editor, human or agent, cannot escalate its own or another member's permissions. Agent authentication and the owner-delegation representation remain Q14; ordinary agent edit membership is insufficient for permission changes.

Confirmed: trashed notes are unavailable through public links, including through public notebook listings. Public attachment access through a trashed note must not bypass that lifecycle check. Restoring a note makes its current public link available again only if effective visibility is public; previously invalidated URLs stay invalid. Public URL replacement requires owner authority in both UI and MCP; ordinary editor membership is insufficient. Previously downloaded copies cannot be recalled by this server-side access change.

Confirmed: notebook moves require ownership, not ordinary edit membership, and v1 allows only notebooks with the same owner. Preserve explicit note overrides; otherwise apply destination notebook permissions. Warn before a move that removes collaborators' effective access. Enforce the same rules through UI and MCP. Proposed MCP contract: expose access impact before an affected move commits, with a versioned precondition so the warning matches the applied change; detailed owner credential delegation remains Q14.

Confirmed clarification: agents can access note metadata, including stored location, through their effective notebook/note permissions; no separate location grant is required. The owner can access it too. Other human collaborators and public visitors remain unable to view location. Enforce this on direct reads, history, metadata, projections, caches, and search results/counts. History access still requires effective edit permission. Do not place restricted location in publicly rendered content or discovery metadata.

Never derive identity from caller-supplied account IDs. Recheck write access at commit time, including claim expiry and offline branch submission. Search results must be scoped before returning excerpts. Private bytes follow explicit access rules. Listing revisions, reading historical content, and comparing versions require effective edit permission; read-only human and agent members and public visitors can access only current content. File links must not expose permanent credentials.

Confirmed: the backend may read/process note content for search and authorized agent operations. V1 does not require end-to-end encryption that prevents server access to content. Every operation still enforces note/notebook access rules, including the agent's collaborator membership and any explicit owner delegation; this decision does not make notes public. Local-cache privacy decisions are recorded under settled Q13.

## MCP foundation

**Confirmed:** official MCP TypeScript SDK v2, targeting protocol `2026-07-28`. This is an SDK/protocol decision, not a manifest format. The owner reconfirmed the earlier modern-MCP direction for the notes app.

**Confirmed acceptance targets:** Codex CLI, Claude Code, Hermes, and Codex accessed over the CLI through Presidium. Exercise the Presidium invocation path separately; success in a standalone CLI does not establish that integration. Exact installed versions and authentication compatibility remain G04/Q14, with no client compatibility accepted yet.

Implement the supported modern transport deliberately; installing SDK v2 alone is not proof that legacy protocol handling is disabled. Any legacy adapter is separately justified by reproduced client incompatibility after reachability, auth, SDK configuration, and client opt-in issues are excluded. Do not claim compatibility with a client that has not been exercised.

Use current official SDK APIs at implementation time. [Official SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

MCP endpoints must work while the browser is closed. They access the current accepted server document and use the same domain operations as the UI. External agents and future in-app agents must not maintain parallel document models or bypass collaboration.

## Agent-facing document contract

Proposed small, coherent model:

- Notebooks: stable IDs, names, descriptions, permission manifests, effective access rights, and filing guidance.
- Collections: personal saved-query views with stable IDs, names, definitions, and authorized matching notes; visible to MCP agents in the associated user context. They cannot be shared/published to other users and have no independent permission controls. Results follow the caller's notebook permissions and note overrides. They are distinct from notebook destinations. Trash is a special collection; access to it does not grant additional lifecycle permissions. V1 collection filters include text, title, notebook, creation date, last-edited date, and stored note location. Location is captured once at creation; authorized agent collaborators can access it and other note metadata under the effective notebook/note permissions. All notes and ordinary collections include matching trashed notes by default, with lifecycle permissions enforced separately.
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
| Share/publish  | Owner-only visibility and public-URL replacement operations, independent of ordinary save                                                           |
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

Confirmed: agent content access is controlled by notebook/note sharing, not a separate connection permission layer. Proposed: independently revocable authentication credentials per connection, bound to the individual collaborator identity; supported authorization discovery/authentication remains an engineering gate. Removing notebook access must take effect without depending on a credential expiring. PAT versus OAuth availability, identity registration, owner-delegation representation, and rate limits remain Q14. Do not assume Better Auth's OAuth packages are automatically compatible with the Convex adapter.

The future sidebar uses the same note operations, claims, and history. It adds conversation state and agent execution, not another persistence authority. Model providers, account credentials, billing, execution environment, and whether agent conversations are shared are Q12. Note contents are data; reading a note does not authorize instructions embedded within it.
