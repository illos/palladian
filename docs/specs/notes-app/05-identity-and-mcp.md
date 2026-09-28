# 05 — Identity and MCP

## Accounts and reliable sessions

**Confirmed Q01:** first usable release is for the owner plus invited collaborators. Public signup is outside that initial scope. Confirmed: notebooks contain notes and are private by default. Notebook and note permissions support private, invited-member, and public URL access. Invited members can be users or individual agents with read-only or edit access. Public visitors are read-only; public visibility never grants edit permission. Editing requires invited edit access. Explicit note permissions override notebook defaults. Only the owner can invite members or change sharing permissions. Notes created in a notebook belong to the notebook owner, including notes created by invited users or agents; creator attribution is separate. Ownership transfer and cross-owner moves remain Q06.

**Confirmed:** v1 sign-in uses email and password. Passkeys, magic-link sign-in, and two-factor authentication are later features, with no release number committed yet. The existing invitation-only account policy still applies. V1 password recovery uses emailed password-reset links delivered through Cloudflare Email Service. This resets the password; magic-link sign-in remains deferred.

Better Auth is the preferred identity/session library. Email verification, reset effects on agent grants, and encryption expectations remain Q08/Q13; supported integration is G03. Do not inherit single-owner security exceptions from Deltos or copy the old app's session state machine.

Required outcomes from the owner's discussion:

- Cached note display does not wait for session validation.
- Ordinary use must not require weekly sign-in. Proposed configuration is a year-scale sliding device session with a shorter access-token lifetime where the integration requires one.
- Renewal has one supported owner. Editor, attachments, search, and app features do not independently rotate credentials.
- Timeout, disconnect, rate limit, or server error is not proof of revocation. Preserve credentials and retry with bounded backoff.
- Confirmed invalid sessions pause authorized remote work and offer sign-in while keeping unsaved work recoverable.
- Device revocation and agent-grant revocation are separate operations. Device failure cannot revoke all agent connections.
- Explicit logout/account switching isolates local state before displaying the next account.
- Late responses cannot overwrite a newer login, restore a signed-out session, or render the prior account's data.

Cached viewing entails retaining previously downloaded private content on the device. Offline revocation cannot instantly erase disconnected copies. Q13 must settle shared-device expectations, local unlock, cache clearing, and encryption. Local snapshots never grant fresh server access.

Better Auth supports configurable lifetime and renewal intervals, but correct settings alone do not prove correct browser behavior. Test transport, origin, cookie/header handling, sleeping tabs, and real token expiry using the chosen version. See [session documentation](https://better-auth.com/docs/concepts/session-management) and [Convex integration](https://labs.convex.dev/better-auth/framework-guides/react).

## Password recovery

Confirmed: the user requests a password-reset email and uses its link to set a new password. Cloudflare Email Service is the delivery provider. A successful password reset automatically signs out other devices; this is not an optional choice in v1. Agent-grant effects remain a separate open Q08 decision.

Proposed implementation: use the auth library's supported reset lifecycle, with expiring, single-use reset tokens, rate-limited requests, and a response that does not reveal whether an email has an account. Keep reset tokens and links out of logs. Requesting a reset must not itself change a password or revoke sessions; invalid, expired, or failed resets must not trigger the successful-reset sign-out behavior. Other-device sessions must lose authorized server access and renewal after successful reset. Local cache and unsaved-work handling follow Q13 and the existing recovery contract; server revocation cannot erase a disconnected device immediately.

G03 requires actual delivery through the selected sender domain and a complete request → inbox → reset → sign-in check, plus expired/reused-link rejection, delivery-failure behavior, and automatic other-device sign-out only after a successful reset. Cloudflare setup prerequisites are recorded in [architecture](03-architecture.md). No email or infrastructure changes are performed by this specification.

## Authorization

Confirmed: authorization must represent individual agents as members, not just a blanket provider label such as Codex or Claude. Both notes and notebooks have permission manifests; explicit note settings take precedence over notebook defaults. The agent identity and credential-linking representation remains an implementation design, with connection authentication covered by Q14.

Proposed: one server-owned authorization layer shared by editor operations, MCP, file access, search, history, and publication. Permission checks cover the effective note/notebook permissions, not just whether a caller is logged in. Notebook membership cannot bypass a more restrictive note override, including through listings, search excerpts, direct reads, files, or MCP.

Only the owner can administer invitations, change member roles, or change public/private visibility. Enforce this in UI and MCP operations; an invited editor, human or agent, cannot escalate its own or another member's permissions. Agent authentication and any owner-authorized credential scope remain Q14; ordinary agent edit membership is insufficient for permission changes.

Never derive identity from caller-supplied account IDs. Recheck write access at commit time, including claim expiry and offline branch submission. Search results must be scoped before returning excerpts. Private bytes follow explicit access rules. Listing revisions, reading historical content, and comparing versions require effective edit permission; read-only human and agent members and public visitors can access only current content. File links must not expose permanent credentials.

Choose privacy expectations before implementing server search and agents. End-to-end encryption that prevents the server from reading content is a materially different architecture; it cannot be silently promised on top of server-side transformations and indexing.

## MCP foundation

**Confirmed:** official MCP TypeScript SDK v2, targeting protocol `2026-07-28`. This is an SDK/protocol decision, not a manifest format. The owner reconfirmed the earlier modern-MCP direction for the notes app.

Implement the supported modern transport deliberately; installing SDK v2 alone is not proof that legacy protocol handling is disabled. Any legacy adapter is separately justified by reproduced client incompatibility after reachability, auth, SDK configuration, and client opt-in issues are excluded. Do not claim compatibility with a client that has not been exercised.

Use current official SDK APIs at implementation time. [Official SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

MCP endpoints must work while the browser is closed. They access the current accepted server document and use the same domain operations as the UI. External agents and future in-app agents must not maintain parallel document models or bypass collaboration.

## Agent-facing document contract

Proposed small, coherent model:

- Notebooks: stable IDs, names, descriptions, permission manifests, effective access rights, and filing guidance.
- Collections: personal saved-query views with stable IDs, names, definitions, and authorized matching notes; visible to MCP agents in the associated user context. They cannot be shared/published to other users and have no independent permission controls. Results follow the caller's notebook permissions and note overrides. They are distinct from notebook destinations.
- Notes: stable ID, single notebook ID, title, metadata, accepted revision, outline, and document URL.
- Content: readable text/Markdown with stable section/block targets; typed references for rich objects.
- Revisions: explicit expected revision or target-version preconditions and compact committed receipts.

Creation accepts substantial Markdown in one request and converts it into native content. Targeted edits preserve untouched rich objects. The agent does not need to synthesize ProseMirror JSON or binary collaboration updates for ordinary tasks.

## Proposed tool surface

Names below are conceptual API names, not frozen wire schemas.

| Tool family    | Contract                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find notebooks | Resolve destination using IDs/names, description, and configured filing guidance                                                                    |
| Collections    | Discover/read personal saved queries through MCP; proposed create/update operations; list authorized matches; no collection sharing/permissions API |
| Search notes   | Ranked authorized excerpts, note IDs, matching section IDs, revision and pagination information                                                     |
| Read note      | Outline, selected sections, or full readable content; clear truncation/pagination; current revision for editing                                     |
| Create note    | Title, destination, Markdown/native supported content, optional metadata, stable request ID                                                         |
| Edit note      | Bounded atomic batch of append/insert/replace/move/delete-content/metadata operations with explicit preconditions                                   |
| Attach file    | Upload/finalize/reference workflow; no whole-body rewrite; explicit size/type limits                                                                |
| History        | List/read/compare require effective edit permission; restore also enforces write authorization                                                      |
| Share/publish  | Owner-only visibility operation, independent of ordinary save                                                                                       |
| Claim/release  | Optional online section checkout, expiry, and takeover semantics                                                                                    |

Prefer stable target IDs; never assume a heading label is unique. Destructive operations state their effects clearly. A tool that saves a private note does not implicitly publish it. Once a note is public, accepted edits automatically update the content at its public URL; no separate publish call is needed. Share/publish changes visibility rather than freezing a revision. Unknown or unsupported blocks remain preserved and readable by description.

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

Proposed: independently revocable scoped grants for each connection; support intended clients through tested authorization discovery and consent. PAT versus OAuth availability, exact scopes, rate limits, and trusted-client defaults are Q14. Do not assume Better Auth's OAuth packages are automatically compatible with the Convex adapter.

The future sidebar uses the same note operations, claims, and history. It adds conversation state and agent execution, not another persistence authority. Model providers, account credentials, billing, execution environment, and whether agent conversations are shared are Q12. Note contents are data; reading a note does not authorize instructions embedded within it.
