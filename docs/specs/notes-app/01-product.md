# 01 — Product

## Purpose

Build a clean notes app that opens quickly on a phone, supports dependable online editing and collaboration, and is as coherent for an authenticated agent to use as it is for a person.

The app must avoid Deltos's failure mode: locally available notes hidden behind a multi-second authentication/network spinner, even on a fast internet connection. Download bandwidth alone does not satisfy startup performance.

## Confirmed priorities

1. Launch, navigation, note titles, and downloaded note content appear without a server round trip.
2. Online writing, saving, and collaboration are the primary working path.
3. Rich embeds, agent tools, remote updates, and sync notifications must not block or degrade ordinary note use.
4. Previously downloaded notes remain viewable without connectivity.
5. Offline editing is a later optional branch. It cannot sit between launch and the ordinary online experience.
6. History preserves work. Divergent offline and online versions can become two copies for the user to resolve.
7. Device-recorded edit times are preserved. Revision ancestry, not clock ordering, determines divergence.
8. Authentication should stay out of the way: no routine weekly login, no false logout due to connectivity, and no device-session failure disconnecting agents.

## Confirmed feature direction

The first usable release is for **the owner plus invited collaborators** (confirmed during specification drafting). Public signup is outside the initial scope. Notebooks are libraries of notes, private by default. Each notebook and note has a permissions manifest: private, private with invited members, or public to anyone with the URL. Members may be users or individual AI agents, each with read-only or edit access. Public URL access is read-only and shows the latest saved content automatically; editing requires invited edit access. Explicit note permissions override notebook defaults. Only the owner can invite members or change sharing permissions. Notes created in a notebook belong to its owner, including notes created by invited users or agents; history preserves creator attribution. Remaining ownership-transfer and link details are Q06.

| Area            | Desired product behavior                                                           | Release commitment                                                  |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Notes           | Simple, clean writing and organization                                             | Core                                                                |
| Editor          | Apple Notes-like continuous rich text, Markdown shortcuts, optional complex embeds | Core; exact formats open                                            |
| History         | Recoverable revisions and restore                                                  | Core foundation                                                     |
| Sharing         | Shareable links and access control                                                 | Modes confirmed; remaining semantics open                           |
| Collaboration   | Realtime editing where possible                                                    | Requested; editor/backend gate                                      |
| External agents | Fast search, creation, editing, attachment, and publishing through MCP             | Core product interface                                              |
| Accounts        | User accounts, reliable authentication, security                                   | Core; owner plus invited collaborators; login/recovery methods open |
| Files           | Pictures, PDFs, documents, miscellaneous files                                     | Requested; limits and previews open                                 |
| Reminders       | Reminders associated with notes                                                    | Requested; delivery and scheduling behavior open                    |
| Agent sidebar   | Converse with an agent and edit a note together                                    | Future feature; not required for first useful MCP access            |
| Offline editing | Preserve local revisions; fork copies on divergence                                | Later extension                                                     |
| Native iOS      | Possible React Native application                                                  | Long term, not a first-release commitment                           |

Proposed first usable release: private notes, basic organization/search, history, account/session reliability, attachments, external MCP, and a narrow sharing/collaboration flow. Reminder delivery and exact sharing scope must be decided before calling a feature-complete v1. See Q02, Q06, and Q07.

## Organization

Confirmed: each note belongs to one notebook at a time. Collections are a separate classifier: saved queries that display matching notes programmatically using criteria such as search text, title, date, and location. Every user starts with an **All notes** collection, which includes notes they own and notes shared with them, and can create additional collections. A note can match multiple collections while remaining in one notebook. Collection results do not transfer ownership or override note/notebook permissions.

Confirmed for the first release: collections are personal to a user and cannot be shared or published to other users, but are visible to MCP agents operating in that user context. Collections have no separate permission controls. Notebook permissions and individual note overrides govern access to matching notes. Exact query operators/date fields, location metadata, and archive/trash inclusion in collections remain open under Q05.

## Editor intent

Internal block identities must not dictate the visible interaction model. Ordinary writing is one continuous surface: select across paragraphs, copy mixed content, and move the cursor naturally. Rich embedded objects have their own controls when needed.

Typing `#HEADER` followed by Tab converts that paragraph into a level-one heading containing `HEADER`. This exact shortcut is owner-requested. Conventional space-triggered shortcuts are proposed companions for mobile keyboards.

Agent paragraph checkout is a desired collaboration direction: indicate which section the agent owns and temporarily prevent conflicting edits there. Expiry, takeover, granularity, and handling in-flight edits require an explicit contract and proof.

## Constraints

- No commercially licensed self-hosted backend as a required solution or reassuring exit plan. Hosted services are not categorically excluded.
- Use MCP TypeScript SDK v2 targeting protocol `2026-07-28`. Legacy compatibility is a separate evidence-driven decision.
- Fast agent use means efficient discovery, few calls, bounded content, and understandable writes; mere availability of an MCP endpoint is insufficient.
- Keep Deltos read-only. Migration of existing notes, reuse of source, production deployment, and retirement of old services require explicit scopes.
- Do not bring back the shelved app-hosting platform, arbitrary app execution, per-app hosting architecture, or its old phase roadmap.

## What this draft does not assume

Notebooks and note-level permission overrides are confirmed. Further organization details, ownership transfer, login method, recovery method, end-to-end encryption requirement, file quotas, retention, and production domain are unresolved. The old single-owner auth plan cannot decide those for the new app.

## Success

A returning user sees actual notes promptly on their phone. Ordinary typing stays responsive while the app reconnects or an agent works. Accepted saves are durable, pending edits are recoverable, and history makes mistakes reversible. An authenticated agent can save a normal-sized conversation in one write once its destination is known, then change a section without rewriting the whole note.

Numeric performance budgets and the reference phone/library must be agreed and measured; see Q10 and A01–A04.
