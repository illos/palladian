# 03 — Architecture and stack

## Chosen direction

Confirmed: prioritize immediate cached display and dependable online editing. The accepted shared document is server-authoritative. The owner permits backend processing of note content for search and authorized agent operations; v1 does not require end-to-end encryption that hides content from the backend. Offline editing is a later branch, not the foundation through which every online operation passes.

```mermaid
flowchart LR
    UI[React notes UI] --> CACHE[Local display snapshots]
    UI --> EDIT[Document editor]
    EDIT --> DOMAIN[Authorized document operations]
    MCP[MCP v2 endpoint] --> DOMAIN
    AGENT[Future sidebar agent] --> DOMAIN
    DOMAIN --> DB[Convex: accepted state and revisions]
    DB -. refresh .-> CACHE
    DOMAIN --> FILES[Private file access]
    FILES --> R2[R2 bytes]
    EDIT -. preserve pending work .-> RECOVERY[Local recovery journal]
    OFFLINE[Later offline editor] -. submit based-on revision .-> DOMAIN
```

This is a responsibility diagram, not a requirement that browser traffic pass through an extra HTTP service. The browser can use Convex directly; MCP is an HTTP boundary over the same authorized operations.

## Proposed stack

The owner suggested React, TanStack Router, Tailwind, Better Auth, Cloudflare, and Convex. The online-first direction was accepted; package selections remain proposals except for the confirmed MCP v2 target and Cloudflare Email Service. Initial app hosting on a default Worker domain is also confirmed.

| Layer          | Candidate                                         | Decision/gate                                                                               |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| UI/build       | React + TypeScript + Vite SPA                     | Recommended; keep initial imports small                                                     |
| Routing        | TanStack Router                                   | Recommended; cached routes must not await remote auth/data                                  |
| Styling        | Tailwind                                          | Recommended; no heavy component suite mandated                                              |
| Editor         | ProseMirror, directly or through Tiptap           | G01: test existing Deltos editor reuse versus Tiptap integration                            |
| Collaboration  | `@convex-dev/prosemirror-sync` first candidate    | G02: prove required behavior and extension points                                           |
| Backend        | Convex                                            | Preferred shared authority, subscriptions, domain operations, scheduled work                |
| Local storage  | IndexedDB + Dexie                                 | Display snapshots and separate durable recovery journal; no Dexie Cloud requirement         |
| Auth           | Better Auth with supported Convex integration     | G03: compatible versions, transport, lifecycle, recovery, MCP OAuth                         |
| Email delivery | Cloudflare Email Service — Email Sending          | Confirmed provider for v1 password-reset emails; actual domain/account delivery remains G03 |
| Hosting        | Cloudflare Workers Static Assets                  | Proposed frontend delivery and narrow HTTP edge responsibilities                            |
| Object bytes   | Private Cloudflare R2                             | Proposed; one file metadata/authorization contract owned by backend                         |
| MCP            | Official TypeScript SDK v2; protocol `2026-07-28` | Confirmed; G04 checks actual target clients                                                 |
| Offline shell  | Service worker                                    | Cache essential app/editor assets; exclude auth ceremonies and credential-bearing traffic   |
| Future native  | React Native possible                             | Deferred; browser editor/Dexie do not automatically become native components                |

No new versions are pinned in this documentation task. When implementing, use the host baseline for Node/pnpm/Playwright/uv and verify library compatibility/security. Preserve required generated types; do not reuse old version pins merely because archived code compiled.

## Local state

| State                 | Meaning                                                      | Recovery behavior                                                                                                                       |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed snapshots   | Last received server versions, titles, previews, content     | Replaceable/rebuildable; account-scoped                                                                                                 |
| Pending-edit journal  | Unacknowledged edits and new drafts created while connecting | Retain through ordinary failures; clear only after acknowledgement, deliberate discard, or the revocation/deletion rules in document 05 |
| Future offline drafts | Deliberate disconnected edits plus their base revisions      | Reconcile or create a conflict copy according to document 04                                                                            |

Never label journal data as a server-confirmed snapshot. Include note or local draft ID, base revision when applicable, operation/request IDs, account scope, and schema version. New-note drafts do not require an existing server revision. Avoid long debounces that make mobile process termination lose acknowledged local work. Browser storage can fail or be evicted; surface save failures and do not claim universal durability against device/browser data deletion.

## Performance boundaries

- Cache the app shell and essential editor assets; network access cannot be necessary to display cached notes.
- Confirmed Q04: cache all current note text in the accessible library; lazy-load pictures and PDFs. Populate text incrementally in the background, keeping network/CPU work off the launch and interaction paths. Persisting the library does not mean hydrating every document into memory at launch.
- Read the list from an indexed projection. Do not hydrate every note/editor to render home.
- Lazy-load advanced features, but avoid serial chunk fetches on ordinary note opening. Precache the basic editor for returning use.
- Isolate editor updates from agent chat, notifications, sidebar state, and full-library rerenders.
- Perform expensive indexing/preview work incrementally and off the interaction path; use workers when justified.
- Reserve embed space; background refresh must not replace typed content or unexpectedly reset selection.
- Establish auth/connection alongside local display. Expected library scale is hundreds to low thousands of notes per user; preserve the same immediate-display behavior across that range. Typical notes contain a couple of pages of text; test longer notes for usable opening, scrolling, selection, and editing before accepting the editor/collaboration stack. Exact benchmark datasets, long-note lengths, and numeric budgets remain Q10.

## Shared backend responsibilities

Convex is proposed to own accepted notes and revisions, authorization, claim leases, sharing/publication records, file metadata, idempotency results, and indexed search projections. UI and MCP call the same mutation/transform rules. Presence can be ephemeral and is not part of permanent note history. Reminders target v2; reminder scheduling/delivery is not a first-release dependency. Proposed for v2: authoritative reminder schedules also live in Convex.

Cloudflare provides frontend delivery and private byte access as needed. Do not duplicate the authoritative note store, permissions rules, or scheduler across providers. A Worker used for MCP or file access must authenticate the caller and invoke the authorized backend contract; an edge deployment is not permission to bypass it.

Cloudflare Email Service is confirmed for password-reset delivery. Proposed: the auth library owns reset-token creation/validation and password changes; the backend sends the resulting transactional message through Cloudflare. Use the REST API or a narrow Worker binding integration after compatibility testing, with sending credentials restricted to the server. Provider acceptance alone does not prove inbox delivery.

A file upload and a database transaction cannot be assumed atomic together. Use staged records and explicit finalize/retry/cleanup behavior. Search and publication projections identify the revision they represent; an acknowledged edit must remain durable even while derived work catches up.

## Technical gates

| Gate | What must be demonstrated                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01  | Natural text selection, composition, paste, embeds, shortcuts, and acceptable editor startup in the primary iPhone Safari installed PWA and desktop Chrome/Firefox using the selected engine                                                                                                  |
| G02  | Centralized collaborative edits; authorizing and validating affected content; claim enforcement and human cancellation with agent-visible interruption; agent transforms; cache-to-live handoff; pending-edit recovery; bounded history/storage costs                                         |
| G03  | Supported Better Auth/Convex arrangement; long-lived sessions; expired short-lived token recovery; late responses/account switches; independently revocable agent credentials; invitation acceptance verifies the invited email; emailed password-reset flow through Cloudflare Email Service |
| G04  | MCP SDK v2 protocol/auth compatibility with Codex CLI, Claude Code, Hermes, and Codex over the CLI through Presidium; exercise each actual environment, not just an SDK unit test                                                                                                             |
| G05  | Representative library/document/file limits, costs, backups, and successful restore; storage limits cannot be removed from tests to make the component fit                                                                                                                                    |

If a gate fails, record the concrete limitation and compare alternatives. Do not silently restore the full local-first architecture or weaken the owner's behavior requirements.

## Technical references recorded during discussion

- [Convex synchronization](https://www.convex.dev/sync): realtime subscriptions are not a complete durable offline sync engine.
- [ProseMirror sync component](https://github.com/get-convex/prosemirror-sync/blob/main/README.md): the discussion-time README describes server-side transforms and durability/presence/size limitations; recheck at implementation. Specifically investigate the 1 MB document ceiling and failed unmount flush. Presence, lock enforcement, and robust recovery are not assumed turnkey.
- [Tiptap integration performance](https://tiptap.dev/docs/guides/performance): isolate editor rendering from unrelated React updates.
- [TanStack Router splitting](https://tanstack.com/router/latest/docs/guide/code-splitting): use splitting without introducing network-dependent cached navigation.
- [Better Auth/Convex React guide](https://labs.convex.dev/better-auth/framework-guides/react): cross-domain transport and compatible versions need deliberate verification.
- [MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/): SDK/protocol target is distinct from an app manifest.
- [Browser storage](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria): offline availability requires capacity and persistence handling.
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) and [sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/), checked 2026-09-28: outbound transactional sending supports password resets through Workers bindings, REST, or SMTP. Docs label Email Sending beta on Workers Paid; domain setup requires Cloudflare DNS and sender-domain onboarding. G03 must verify the selected account/domain and actual recipient delivery before acceptance. Provider selection does not authorize plan purchases or DNS changes.

## Initial hosting and pricing

Confirmed: use the default Cloudflare Worker domain (`workers.dev`) for the initial app; no custom app domain is required. Pricing decisions remain with the owner, rather than requiring a monthly budget to finish this specification. This does not select paid plans or authorize purchases. The email sender-domain/account prerequisites remain separate from the app URL and still require G03 verification.
