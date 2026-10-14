# 07 — First-release delivery plan

Status: **adopted 2026-10-14**, resolving Q02 under owner decisions D91–D94. This plan orders the confirmed v1 scope; it does not remove any confirmed requirement.

## Owner direction

- Sharing and the authorization filter ship in the first live release (D91). Every read, search, edit, history and agent path goes through one server-side access check from the first commit.
- Engineering selects the collaboration backend (D92). The disposable proof in `spikes/notes-services` stays as historical evidence; it is not promoted.
- External agents connect through OAuth, so the owner can sign in from Claude and ChatGPT subscriptions as well as Claude Code and Codex (D93).
- Convex production and Cloudflare Worker deployments are authorized when needed (D94). DNS changes, plan purchases and real-data import still need a separate owner decision.

## Architecture

| Package | Responsibility |
| --- | --- |
| `packages/notes-core` | Shared ProseMirror schema with stable block IDs, Markdown conversion, title/preview/text projections, agent edit operations |
| `apps/notes-backend` | Convex: principals, notebooks, memberships, note overrides, notes, content, step log, checkpoints, history, invitations, agent connections, public links, search |
| `apps/notes` | Cached-first PWA: library sync, collaborative editor, sharing and connection management, OAuth consent page |
| `apps/notes-edge` | Cloudflare Worker on `workers.dev`: static assets, OAuth authorization server, MCP endpoint, public pages |

**Documents.** The server stores the accepted ProseMirror document, its revision, and every accepted step. Editors use `prosemirror-collab`: they submit steps against a revision and rebase over steps they receive. Agent Markdown edits are converted into steps on the server at the current revision, so open editors absorb them the same way. Checkpoints every 100 revisions make any revision reconstructable without replaying the whole log. History groups consecutive edits by actor and idle time.

**Authorization.** Notes belong to the notebook owner. Effective access is: owner; else an explicit note grant (which may deny); else none if the note is restricted; else the notebook membership. Owner-only actions (sharing, moves, publishing, permanent deletion) also accept an agent explicitly delegated that action by its controlling owner. Read-only members receive current content, never steps or history.

**Agents.** Each OAuth connection is an individual agent principal controlled by the person who approved it. The consent screen shares chosen notebooks with that agent, using ordinary membership rows; authentication alone grants nothing. The Worker validates OAuth tokens, then calls Convex with a short-lived JWT naming the agent and connection. Convex checks that the connection is still active on every call, so revocation is immediate.

**Library sync.** Each notebook keeps a change sequence. Clients subscribe to changes after their cursor and cache summaries and bodies in IndexedDB, so typing in one note does not resend the whole library.

## Order of work

1. **Core loop with sharing model:** shared schema and Markdown, the Convex domain with authorization, live collaborative editing, library sync into the existing cache, owner bootstrap. Deploy Convex production and the Worker.
2. **MCP with OAuth:** consent page, agent connections, tools for notebooks, search, listing, reading, creating, targeted editing, Trash and history. Exercise Claude Code and Codex CLI directly; the owner connects claude.ai and ChatGPT.
3. **Sharing surfaces:** notebook and note sharing dialogs, invitations, agent selection, delegated actions, public read-only links.
4. **Remaining v1:** history browsing and restore UI, Trash retention, agent claims with human cancellation, collections, files on R2, location.

Invitation and password-reset email need a sender domain on Cloudflare Email Service; until the owner chooses one, invitations use copyable single-use links.

Protected changes (authentication, authorization, collaborative persistence, agent scopes, file access) receive independent review before acceptance, recorded under `docs/reviews/`.
