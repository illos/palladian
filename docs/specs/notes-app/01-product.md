# 01 — Product

## Purpose and priorities

Build a clean notes app that opens quickly on a phone, supports dependable online editing and collaboration, and gives authenticated agents a fast, coherent interface.

Deltos hid downloaded notes behind a multi-second authentication/network spinner even on fast internet. Palladian must display cached navigation, titles, and content without a server round trip. Home uses a small local index; opening one note must not hydrate the whole library. Existing notes may briefly remain read-only until live editing is ready. New note opens immediately for typing into a local draft while connecting.

Online editing is the primary working path. Rich viewers, agent tools, indexing, remote updates, and notifications stay off the launch and interaction paths. Automatically cache all accessible current note text for offline viewing; images and PDFs lazy-load. Offline editing comes later as a separate adapter. Divergence creates two copies for user resolution, using revision ancestry rather than device-clock ordering; preserve device edit times as provenance.

## Confirmed release direction

| Area            | V1 requirement                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Accounts        | Owner plus invited collaborators; no public signup; email/password, emailed invitations and password reset      |
| Notes/editor    | Continuous Apple Notes-style rich text, first-line title, Markdown input shortcuts                              |
| Organization    | Flat notebooks, personal query collections, All notes and Trash, search                                         |
| History         | Lifetime reconstructable revisions while a note exists; editor access; permanent deletion clears all history    |
| Sharing         | Private, invited read/edit members, public read-only URLs showing latest accepted content                       |
| Collaboration   | Online human/agent editing with necessary-scope agent claims and human cancellation, subject to technical proof |
| External agents | Fast MCP discovery, search, creation, targeted editing, attachments, history, and authorized publishing         |
| Files           | Separate unversioned images, PDFs, documents, and miscellaneous objects referenced from notes                   |

Confirmed v1 formatting: headings, bold, italic, strikethrough, links, ordered/unordered lists, checklists, quotes, code, images, and file attachments. Ordinary writing is one continuous surface with natural cross-paragraph mobile selection. Stable internal block IDs must not create isolated paragraph text boxes. Optional specialized embeds fit inside that surface; their advanced scope remains Q05.

Typing `#HEADER` followed by Tab converts the paragraph to H1 containing `HEADER`. Space-triggered mobile companions are proposed. The first line supplies the title; an empty first line displays **Untitled** without inserting text. There is no independent title field. Note lists sort by most recently edited; other sorts come later.

**Deferred:** reminders target v2. Offline editing, sidebar agent chat, passkeys, magic-link login, two-factor authentication, editable tables, folders, and explicit offline attachment downloads come later without an assigned release. Native iOS/React Native is a possible long-term direction. V1 has no tags, pinning, or separate archive feature; an ordinary notebook can serve as an archive. No future tag feature is committed.

Q02 consolidates a delivery plan around these requirements; it does not downgrade confirmed features. Deltos import is a separately assigned manual agent job using ordinary MCP operations, without a required in-app migration wizard.

## Ownership and organization

A note belongs to one notebook and to that notebook's owner, regardless of its creator; preserve actual creator attribution. Notebooks are private by default, flat, and never nested. Moves are between notebooks with the same owner; ownership transfer is outside v1. Preserve note IDs/history/objects and explicit permission overrides. Warn before a move that removes effective collaborator access.

Notebook permissions provide defaults; explicit note permissions override them. Invited members are individual users or AI agents with read/edit rights. Agent authentication alone grants no private content. Owners may explicitly delegate trusted agents to publish, change sharing, move notes, or permanently delete; ordinary edit membership is insufficient. URL replacement requires its specified owner authority. See [authorization](05-identity-and-mcp.md#authorization).

Collections are personal saved queries, visible to MCP agents in the associated user context but not shareable/publishable to other users. They have no independent ACL and never grant note access. Every user starts with **All notes**, including owned/shared notes and matching Trash. A note can match multiple collections without being copied. Trash is also a special collection. Confirmed query fields are text, title, notebook, creation date, last-edited date, and location.

Location is captured once at creation when available; content edits do not recapture it. Users can change/remove it manually. Denied/unavailable location does not impair normal note use. Owners and agents with effective access can read it; other human collaborators and public visitors cannot. Query operators and precision remain Q05.

## Sharing, privacy, and lifecycle

Public URLs show latest accepted live content, read-only, without automatic expiry; subsequent saves need no republish action. Public pages are indexable by default. Trashing hides the public link; restore re-enables its current URL only if visibility still allows. Owner URL replacement permanently invalidates the old URL. Read-only members/public visitors cannot view history; effective edit access is required.

Trash retention choices are **1 day, 1 week, 30 days (default), 90 days, forever**. The note owner's current policy applies to existing and future Trash. Editors may trash/restore; permanent deletion requires owner authority, including explicit agent delegation. It clears the note and its entire history. Separate object-reference rules preserve attachments used by another active note; historical references do not keep trashed bytes forever. See [behavior](02-behavior.md) and [documents](04-documents.md).

No routine weekly login or false logout due to connectivity. Expiry preserves cached viewing; voluntary logout and learned device revocation clear account caches. Effective note-access loss removes affected content and disallows unsaved-work export. Voluntary logout offers save/export/discard for accessible pending work. Device security is sufficient for v1 local storage. Backend processing for search and authorized agents is allowed; v1 does not require end-to-end encryption. Password reset signs out other devices and asks whether to disconnect agents. See [identity](05-identity-and-mcp.md).

## Clients, scale, and constraints

Primary target: installed Safari PWA on the owner's **iPhone 15 Plus**; test other sizes where possible. Support desktop Chrome and Firefox. Expect hundreds to low thousands of notes per user, usually a couple of pages of text. Test progressively longer notes for usable opening, selection, scrolling, editing, and saving; these expectations are not quotas or maximum lengths.

MCP acceptance targets: Codex CLI, Claude Code, Hermes, and Codex CLI through Presidium. Use TypeScript SDK v2 targeting protocol `2026-07-28`; actual compatibility is G04. Agent success means bounded reads/writes, few calls, understandable results, and one-write conversation creation once its destination is known.

Initial app URL uses the default Cloudflare Worker domain; pricing stays with the owner. No commercially licensed self-hosted solution. Deltos stays read-only; preserve the shelved platform and its archive. Implementation, import, deployment, and infrastructure changes require separately assigned scopes.

Remaining decisions and technical proofs are listed in [document 06](06-decisions-and-acceptance.md#remaining-decisions-and-engineering-contracts). Accepted saves must be durable and ordinary pending work recoverable, subject to explicit discard, revocation, and permanent-deletion policies.
