# 01 — Product

## Purpose

Build a clean notes app that opens quickly on a phone, supports dependable online editing and collaboration, and is as coherent for an authenticated agent to use as it is for a person.

The app must avoid Deltos's failure mode: locally available notes hidden behind a multi-second authentication/network spinner, even on a fast internet connection. Download bandwidth alone does not satisfy startup performance.

## Confirmed priorities

1. Launch, navigation, note titles, and downloaded note content appear without a server round trip. Existing cached notes may briefly remain read-only while live editing becomes ready; reading and navigation remain available throughout (confirmed Q03).
2. Online writing, saving, and collaboration are the primary working path.
3. Rich embeds, agent tools, remote updates, and sync notifications must not block or degrade ordinary note use.
4. Automatically download and retain all note text for fast opening and offline viewing. Pictures and PDFs load lazily when needed (confirmed Q04). Previously downloaded notes remain viewable without connectivity.
5. Offline editing is a later optional branch. It cannot sit between launch and the ordinary online experience.
6. History preserves work. Divergent offline and online versions can become two copies for the user to resolve.
7. Device-recorded edit times are preserved. Revision ancestry, not clock ordering, determines divergence.
8. Accepting an emailed invitation verifies the invited email address without a separate verification email. V1 sign-in uses email and password, with password-reset links delivered through Cloudflare Email Service; passkeys, magic-link sign-in, and two-factor authentication are deferred to a later release. A successful password reset automatically signs out other devices; the reset flow asks whether to disconnect connected AI agents. Authentication should otherwise stay out of the way: no routine weekly login, no false logout due to connectivity, and no device-session failure disconnecting agents.

## Confirmed feature direction

The first usable release is for **the owner plus invited collaborators** (confirmed during specification drafting). Public signup is outside the initial scope. Notebooks are libraries of notes, private by default. Each notebook and note has a permissions manifest: private, private with invited members, or public to anyone with the URL. Members may be users or individual AI agents, each with read-only or edit access. Public URL access is read-only and shows the latest saved content automatically; editing requires invited edit access. Explicit note permissions override notebook defaults. Only the owner can invite members or change sharing permissions. Notes created in a notebook belong to its owner, including notes created by invited users or agents; history preserves creator attribution. V1 notebook moves are owner-only and limited to notebooks with the same owner; ownership transfers are deferred. Destination permissions apply unless explicit note-level overrides exist, which remain intact. Warn before a move when collaborators will lose access. Remaining link details are Q06.

| Area            | Desired product behavior                                                           | Release commitment                                             |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Notes           | Simple, clean writing and organization                                             | Core                                                           |
| Editor          | Apple Notes-like continuous rich text, Markdown shortcuts, optional complex embeds | V1 formatting set confirmed; advanced embeds open              |
| History         | Recoverable revisions and restore                                                  | Core foundation                                                |
| Sharing         | Shareable links and access control                                                 | Modes confirmed; remaining semantics open                      |
| Collaboration   | Realtime editing where possible                                                    | Requested; editor/backend gate                                 |
| External agents | Fast search, creation, editing, attachment, and publishing through MCP             | Required in v1                                                 |
| Accounts        | User accounts, reliable authentication, security                                   | Core; invited accounts; email/password v1; emailed reset links |
| Files           | Pictures, PDFs, documents, miscellaneous files                                     | Requested; limits and previews open                            |
| Reminders       | Reminders associated with notes                                                    | V2 target confirmed; delivery and scheduling behavior open     |
| Agent sidebar   | Converse with an agent and edit a note together                                    | Confirmed later; outside v1                                    |
| Offline editing | Preserve local revisions; fork copies on divergence                                | Later extension                                                |
| Native iOS      | Possible React Native application                                                  | Long term, not a first-release commitment                      |

Proposed first usable release: private notes, basic organization/search, history, account/session reliability, attachments, external MCP, and a narrow sharing/collaboration flow. Reminders are a confirmed v2 target and do not block the first usable release. Remaining first-release scope and sharing details are Q02/Q06; reminder delivery details (Q07) can be settled for v2.

Confirmed: Deltos note import is a manual job run by an agent. Provide the ordinary MCP note-creation and attachment operations needed for that workflow; an automatic in-app migration wizard is not a v1 requirement. The actual import source/scope and timing remain to be assigned.

## Organization

Confirmed: notebooks form a flat list and never nest inside other notebooks. Folders may be considered later as a separate organizational feature; they are not in the first release. Each note belongs to one notebook at a time. Collections are a separate classifier: saved queries that display matching notes programmatically using criteria such as search text, title, date, and location. Every user starts with an **All notes** collection, which includes notes they own and notes shared with them, and can create additional collections. A note can match multiple collections while remaining in one notebook. Collection results do not transfer ownership or override note/notebook permissions.

Confirmed for the first release: collections are personal to a user and cannot be shared or published to other users, but are visible to MCP agents operating in that user context. Collections have no separate permission controls. Notebook permissions and individual note overrides govern access to matching notes. Confirmed: Trash acts as a special collection. V1 filters cover text, title, notebook, creation date, last-edited date, and location. The app asks for location access and stores location with the note for searching. Capture location once at note creation; later edits do not update it. Stored location is owner-only, even when the note is shared or public. Notes work normally without location when permission is denied or location is unavailable. Exact operators, precision, and ordinary-collection Trash filtering remain Q05; owner-delegated agent access remains Q14.

Confirmed: the first line of the note automatically supplies its title. Confirmed v1 scope: no tags, editable tables, pinning, or separate archive feature. Users can move notes between notebooks and create an ordinary notebook for archiving; its name does not give it special lifecycle behavior. Note lists use most recently edited first; additional sorting options are deferred to a later release. Tables are deferred with no release assigned; tags have no committed future scope.

Confirmed: v1 supports headings, bold/italic/strikethrough, links, ordered/unordered lists, checklists, quotes, code, images, and file attachments. External agent access through MCP is required in v1; the in-app agent chat sidebar comes later.

## Editor intent

Internal block identities must not dictate the visible interaction model. Ordinary writing is one continuous surface: select across paragraphs, copy mixed content, and move the cursor naturally. Rich embedded objects have their own controls when needed.

Typing `#HEADER` followed by Tab converts that paragraph into a level-one heading containing `HEADER`. This exact shortcut is owner-requested. Conventional space-triggered shortcuts are proposed companions for mobile keyboards.

Agent paragraph checkout is a desired collaboration direction: indicate which section the agent owns and temporarily prevent conflicting edits there. Expiry, takeover, granularity, and handling in-flight edits require an explicit contract and proof.

## Content privacy

Confirmed: the backend may process note content for search and authorized agent operations. V1 does not require end-to-end encryption that prevents the backend from reading content. Note and notebook permissions continue to govern user and agent access. Explicit sign-out clears the account's cached notes and downloaded attachments from the app on that device.

## Constraints

- No commercially licensed self-hosted backend as a required solution or reassuring exit plan. Hosted services are not categorically excluded.
- Use MCP TypeScript SDK v2 targeting protocol `2026-07-28`. Legacy compatibility is a separate evidence-driven decision.
- Fast agent use means efficient discovery, few calls, bounded content, and understandable writes; mere availability of an MCP endpoint is insufficient.
- Keep Deltos read-only. Migration of existing notes, reuse of source, production deployment, and retirement of old services require explicit scopes.
- Do not bring back the shelved app-hosting platform, arbitrary app execution, per-app hosting architecture, or its old phase roadmap.

## What this draft does not assume

Notebooks and note-level permission overrides are confirmed. Further organization details, local-cache privacy policies, file quotas, remaining retention details, and production domain are unresolved. Ownership transfers are deferred beyond v1. The old single-owner auth plan cannot decide those for the new app.

## Supported clients

Confirmed: Safari as an installed PWA is the primary target, with Chrome and Firefox on desktop supported. The primary mobile acceptance environment is a real iPhone running the installed PWA. Native iOS remains a possible later direction. Exact device, OS/browser versions, benchmark fixtures, and performance budgets remain Q10.

## Success

A returning user sees actual notes promptly on their phone. Ordinary typing stays responsive while the app reconnects or an agent works. Accepted saves are durable, pending edits are recoverable, and history makes mistakes reversible. An authenticated agent can save a normal-sized conversation in one write once its destination is known, then change a section without rewriting the whole note.

Confirmed expected scale: hundreds to low thousands of notes per user. This is a performance workload target, not an account quota or hard note limit. Most notes are expected to contain a couple of pages of text. Longer notes must also be possible and usable, with explicit usability testing; this does not establish a maximum document size. Exact benchmark counts and note lengths, numeric performance budgets, and the reference phone remain to be established and measured; see Q10 and A01–A04.
