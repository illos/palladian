# Palladian platform specification

Date: 2026-09-09  
Status: implementation handoff; no application has been implemented or validated.  
Owner: Jim. Execution workflow: bounded implementation by a coding model, then independent review of core changes.

## 1. Product and scope

Palladian is a personal web-app platform: a polished home for small, purpose-built apps created by coding agents. A notes editor is one app. Recipes, fiber splice diagrams, NPC collections, and vehicle searches are examples of other apps; they must not have to imitate notes.

The platform supplies identity, data conventions, file storage, search, navigation, theme, and optional tools. Agents write ordinary application code against those facilities. This is not a visual app builder, a universal block editor, or a runtime that executes arbitrary generated code.

An app works inside the Palladian shell, through a direct URL, and as an individually installed PWA. A registered custom hostname may provide another entry point to the same app instance. All entry points use the same authoritative data. Separate browser origins and installed PWAs may require separate initial sign-ins; that is accepted.

### Confirmed decisions from the owner

- Convex for authoritative structured data, reactive updates, and backend operations.
- Cloudflare Workers Static Assets for frontend hosting; R2 for object bytes.
- Better Auth integrated with Convex is the candidate identity/session implementation. Validate it against the known Deltos failures before adopting it; do not silently substitute the separate Convex Auth library.
- Online-first. Full offline operation and deliberate offline-to-online merging are secondary goals.
- Interactive sign-in approximately once a year at most during ordinary use of an entry point. Explicit logout, revocation, cleared browser data, recovery, and new installations are exceptions.
- Fast homescreen rendering is a core requirement. Authentication must not block the entire shell.
- Theme, API/data conventions, navigation/search integration, and permissions are required platform contracts.
- Deck, voice input, upload UI, scheduling, notifications, and editors are reusable tools. Apps may replace their UI while retaining platform service and access contracts.
- Shared managed infrastructure, app-owned data models, enforced ownership boundaries.
- The platform remains accessible through integrated and standalone experiences.
- MCP targets TypeScript SDK v2 and protocol revision `2026-07-28` only initially. Required clients are ChatGPT, Codex, and Claude Code. Add legacy compatibility only after a required client's lack of new-protocol support is confirmed by an actual compatibility test; missing documentation is not confirmation.

### Implementation defaults chosen by this specification

These are concrete defaults, not statements that the owner separately selected each one. Record a proposed deviation before changing one.

- React + TypeScript + Vite SPA, pnpm workspace, strict TypeScript, one repository and one versioned deployment set initially.
- One private owner workspace initially. Test with a second user/workspace to prove isolation. No public registration, billing, team-sharing UI, or app marketplace in v1.
- Trusted, reviewed, build-time app modules. No runtime remote module loader, uploaded JavaScript, user-supplied backend code, or per-app package installer.
- Notes and Recipes are the two required example apps. The diagram/NPC/vehicle apps are future consumers, not extra v1 deliverables.
- Stable instance IDs in URLs; human titles can change without breaking links.
- Native keyboard and standard editor controls ship before the optional custom Deck.
- Long-lived device sessions should slide with activity if the selected integration supports this correctly: proposed Better Auth policy is 365-day expiry with renewal no more frequently than daily. Do not accidentally add a shorter inactivity cutoff or absolute annual forced logout to a sliding policy.
- Initial login is private owner email/password using library-provided credential handling. Recovery and optional TOTP must be designed and tested before real data adoption; see phase P1. No custom cryptography.

### Relationship to existing Deltos work

This is a new platform in `/srv/presidium/projects/palladian/code`. The old source is `/srv/presidium/projects/deltos/code`. Read it selectively as reference; do not modify it as part of this build.

The 2026-08-20 migration plan described renaming the existing notes product and publishing a separate input framework. That is historical context, not the build plan for this project. Do not clone its D1 schema, sync engine, auth state machine, 450-file rename, or public-package publication work into Palladian. Deltos's existing personal data and live deployment remain intact.

Preserving data and avoiding two writers remain valid principles for a future import/cutover. Import, production cutover, old infrastructure retirement, and publishing the Deck as a separate open-source package are outside this implementation spec.

## 2. Delivery definitions

**Foundation pilot:** P0–P4 accepted: platform, proven auth, storage/search, functional Notes and Recipes. Development data only. This is not the complete product.

**Platform v1:** P0–P9 accepted: pilot plus MCP integration, reusable tools, standalone installs/custom-host binding, recovery, and operational verification. A deferred or mocked phase is not complete.

**Personal-data adoption:** separate owner-authorized deployment/import decision after v1 evidence. Do not interpret this document as permission to move or delete existing Deltos data.

## 3. Architecture and trust model

```text
Browser / installed PWA
  Cloudflare-served shell + lazily loaded app UI
  Better Auth session client -> auth HTTP surface
  Convex client -> authenticated queries and mutations
  granted upload/download -> private R2 objects

Convex
  identity adapter and authorization helpers
  workspace + app-instance registry
  app-specific typed tables and functions
  search projection + file metadata
  schedules + notification inbox + operation registry

Cloudflare
  static frontend and routing
  private R2 buckets
  narrowly scoped edge handlers where actually required
```

Keep ordinary data traffic on the Convex client. Do not recreate a REST CRUD layer or polling sync engine alongside it. HTTP handlers are appropriate for auth, MCP, external callbacks, and hostname routing. Browser modules receive no deployment keys, R2 credentials, or server secrets.

Use a shared production Convex deployment initially, with dedicated development/test deployments. Separate R2 buckets and hostname bindings by environment. D1 is not a second authoritative database. R2 is intentional despite any generic backend skill recommending an all-Convex stack.

### Security boundary that must not be overstated

Build-time modules in one frontend origin and backend repository are trusted application code. A namespace, TypeScript wrapper, manifest capability list, or URL path is not a sandbox against malicious code. These measures prevent routine mistakes and enforce public API ownership; they do not make unreviewed code safe to execute.

Every externally callable backend operation performs authorization. Its permitted app definition is fixed by its implementation/registration, not chosen by a caller-supplied `appId`. An app-instance argument selects an instance of that definition only. Do not expose a general endpoint accepting arbitrary table names or function paths.

Future untrusted apps require a separate isolation design (origins, execution environments, capabilities); do not claim v1 supports them.

## 4. App and data contracts

### Vocabulary

- **User:** authenticated identity mapped to a stable platform user ID. Keep provider-specific identity details behind one adapter.
- **Workspace:** owner boundary and home for app instances. One user may eventually own several; v1 UI may expose one.
- **App definition:** trusted code such as `notes` or `recipes`.
- **App instance:** a workspace's installation of a definition, with its own data, title, preferences, and navigation position. Two recipe instances have different IDs and records.
- **Resource:** an app-owned item addressed by `(instanceId, resourceType, resourceId)`.
- **Entry point:** integrated URL, standalone URL, PWA launch, or registered hostname resolving to an instance. It is not a copy of the instance.

### Definition manifest (conceptual interface, not a library API)

```ts
import type { ComponentType } from "react";

interface AppHostProps {
  workspaceId: string;
  instanceId: string;
  presentation: "integrated" | "standalone";
}

interface AppUIModule {
  Root: ComponentType<AppHostProps>;
}

interface AppDefinition {
  id: string;                 // immutable, e.g. "recipes"
  contractVersion: 1;
  name: string;
  icon: string;               // approved bundled icon identifier
  resourceTypes: readonly string[];
  capabilities: readonly string[];
  loadUI: () => Promise<AppUIModule>;
}
```

These are frontend contract types; use generated branded IDs at backend boundaries. Shared services are obtained from a typed host provider rather than adding credentials to these props. Keep the manifest lightweight; it must not import an editor or the app runtime eagerly. Backend registration is separate and server-owned. Finalize typed resource and service interfaces during P0; no `any` escape hatch in the public SDK.

Every app must provide:

1. Typed schema, indexed scoped queries, validated mutations, and resource-level access checks.
2. Lazy UI entry accepting a platform context with instance ID and presentation mode.
3. Internal routing and stable resource links through the shared link resolver.
4. Search projection builder and a resource resolver that checks live existence and access.
5. Export and deletion handlers for its records and file references.
6. Machine-readable agent operations with descriptions, schemas, effects, and scopes.
7. Loading, empty, disconnected, denied, missing, and recoverable-error states.
8. Theme tokens and accessible keyboard/touch behavior.

Optional capabilities use explicit typed adapters. No app accesses another app's tables by importing its internals. App-to-app operations, when needed, use a registered server operation with an explicit grant; v1 does not need a sharing UI.

### Logical schema

Names below describe required entities; adapt exact field validators to the pinned Convex version. Never pretend these are generated Convex types.

| Entity | Required information and indexes |
|---|---|
| Platform users | stable ID, auth-provider subject mapping; unique mapping enforced transactionally |
| Workspaces | owner platform user ID, title; by owner |
| App instances | workspace ID, definition ID, title, lifecycle state, sort order, preferences version; by workspace |
| Search entries | workspace/instance IDs, resource type/ID, title, bounded plain text, source revision/time; compound resource identity and scoped search index |
| Files | workspace/instance IDs, opaque object key, display filename, declared/verified type and size, upload state, timestamps; by instance and state/time |
| File references | file ID + resource identity; by file and resource, duplicate prevention |
| Notes | workspace/instance IDs, title, collaborative-document reference, revision metadata, trash state; by instance and lifecycle |
| Recipes | workspace/instance IDs, title, ordered ingredients/steps, servings, optional photo file ID, revision, trash state; by instance and lifecycle |
| Agent grants | hashed credential identifier, owner/workspace, allowed instances and operations, expiry policy, revocation state; lookup by credential hash |
| Schedules | owner/workspace/instance, registered operation ID, validated payload, next run, timezone/recurrence, generation, state |
| Notifications | owner/workspace/instance, title/body, internal resource target, created/read timestamps, deduplication key; scoped chronological indexes |
| Operation receipts | scoped idempotency key, operation/payload fingerprint, result reference, retention metadata |
| Domain bindings | normalized verified hostname, instance ID, environment, lifecycle state; unique hostname |

Use typed app-specific tables. Do not build one unvalidated `records { appId, data: any }` table. Children are checked against their actual parent instance/workspace before use. IDs supplied by the browser never establish ownership.

Store timestamps in UTC; recurrence also stores an IANA timezone. Define bounded field lengths, upload limits, and page sizes in shared constants before exposing endpoints. Defaults: list page 25, max 100; search page 20, max 50. Paginate growth-prone collections; no unbounded production scans.

### Mutation rules

- Prefer semantic operations such as `renameRecipe` or `setServings` to whole-record replacement.
- On concurrently edited structured values, use revisions and return a recoverable conflict; preserve the user's unsaved input. Do not silently discard or blindly retry stale replacement writes.
- Retriable non-idempotent commands such as create, agent writes, and scheduled side effects use a scoped idempotency key. Reusing a key with a different payload is an error.
- Transactional database writes update simple search projections and references together where possible. External side effects use explicit pending/succeeded/failed state and retries; never claim R2 or third-party calls are atomic with Convex.
- Public error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION`, `RATE_LIMITED`, `TEMPORARY`. Avoid disclosing resource existence to unauthorized callers. Internal details go to redacted diagnostics.

## 5. Authentication and startup: protected core

### Existing failure evidence to preserve

The Deltos investigation recorded:

- At least nine uncoordinated refresh call sites; zero-grace single-use token rotation.
- A production rotation followed by revocation 49 ms later.
- Refresh reuse revoking the account's agent/OAuth grants as well as device sessions.
- A 3-second client timeout losing a response after the server had committed rotation.
- Transient failures clearing credentials and a permanently latched revoked state.
- Memory-only 15-minute access tokens and a shell that waited for refresh on every cold launch.

A larger expiry value alone does not repair these issues. Do not reuse that state machine or its account-wide failure response.

### Required authentication behavior

1. One identity across apps; independent long-lived sessions per origin/PWA are allowed.
2. Keep long device-session lifetime separate from temporary Convex access JWT lifetime. Use the supported library refresh lifecycle; don't implement rotating refresh tokens from scratch.
3. Centralize token acquisition in the supported integration. Apps, file tools, search, and editor code must not independently call refresh endpoints. Test both concurrent same-tab consumers and multiple tabs/PWA contexts.
4. Network errors, timeouts, rate limits, and 5xx responses do not delete valid credentials, revoke sessions, revoke agent grants, or redirect directly to login.
5. A confirmed expired/revoked session shows a sign-in-needed state. Keep unsaved editor work recoverable. Clear private caches on explicit logout or account switch; do not display another account's cached content.
6. Device revocation affects that session. Agent disconnection affects that grant. Explicit revoke-all is a separate owner action. Password recovery revokes device sessions; agent revocation is a separate explicit choice.
7. Server authorization must account for revoked sessions, not merely an unexpired JWT. Define the immediate-revocation check centrally and test it. Short-lived already-issued file URLs have a separately documented expiry window.
8. No wildcard trusted origins, credentialed wildcard CORS, disabled CSRF validation, or caller-controlled auth callback hosts.
9. Auth credentials never enter resource URLs, search entries, telemetry, exports, or service-worker caches.
10. Real-data use requires a tested recovery path and optional TOTP with recovery behavior. Preserve the prior preference for phrase-based recovery as a requirement to resolve with the reviewer; use a supported library mechanism or explicitly approved recovery design, never an improvised cryptographic implementation. An operator-reset-only development account is acceptable for the pilot and must be labeled as such.

### Compatibility investigation required in P0/P1

The earlier Deltos plan pinned Better Auth 1.7.1 with MCP packages. The Convex React integration guide retrieved on 2026-09-09 instead showed Better Auth `~1.6.15`. These are not interchangeable deployment recipes. Before installation, inspect current package releases, peer dependencies, advisories, official integration source, and supported plugins. Pin a mutually compatible, security-supported set in the lockfile and record why it was selected. If no set supports a required behavior, report the exact blocker; do not downgrade silently or remove the requirement.

Prove the selected SPA auth transport on the actual origin arrangement. The documented cross-domain integration, cookie sessions, cookie caching, custom-domain routing, and first-party proxying have different behavior. Do not combine snippets from separate guides and assume cookie semantics. Record where credentials live, how they renew, how revocation is checked, and how each hostname/PWA obtains a session. Prefer a supported integration; a proxy must preserve all `Set-Cookie` headers and retain origin/CSRF validation. Do not implement a custom auth proxy before review of its design.

### Startup state model

Model network connectivity, authentication readiness, and save status separately.

| Condition | User experience |
|---|---|
| Shell starting/auth resolving | Render theme, navigation frame, and non-sensitive app registry; scoped live data region may load |
| Auth confirmed, online | Live queries and editing available |
| Temporary connectivity loss | Keep visible content and pending input; show reconnecting/unsaved state; no login bounce |
| Session confirmed invalid | Sign-in banner/surface; no authorized writes; retain recoverable draft safely |
| Explicit logout/account switch | Clear account-scoped visible state and caches before rendering another account |

The shell is not nested entirely under an authenticated-only render gate. Login UI, editor, diagrams, Deck, dictionaries, voice processing, and inactive apps are separate lazy chunks. A cached static shell is allowed now; a local authoritative database is not.

## 6. Notes and concurrent editing: protected core

Use a maintained collaborative editing implementation compatible with the selected editor. Evaluate `@convex-dev/prosemirror-sync` first because Deltos uses ProseMirror; Yjs or another protocol requires an explicit review decision. Inspect current source and supported persistence behavior, not only a historical example.

The note body has exactly one authoritative collaborative representation. Do not dual-write independently authoritative spine JSON and ProseMirror JSON. The old app's spine model is a reference, not a requirement for a new platform. Derived plain text/markdown for search/export is versioned and reconstructible.

All body edits, including MCP edits, go through the collaborative protocol. Never expose `setNoteBody` that overwrites a snapshot while clients edit. Agent operations must apply a transform against a known revision or return a conflict; retries must not duplicate insertions. Prefer an explicit append operation for v1, with revision-aware patch operations only when verified. Fetch for agents resolves the current document, not a possibly stale search snapshot.

Notes v1 supports title, paragraphs, headings, lists, checklist, links, code blocks, basic marks, attachments, trash/restore, plain-text/markdown export, and a readable recovery/history surface. Optional custom blocks/formulas are not required.

Local typing is immediate. A saved indicator means the authoritative server has acknowledged the relevant changes. Incoming remote edits must not reset the editor, cursor, or undo history unnecessarily. Title/metadata revisions are distinct from collaborative body versions.

During brief disconnections, retain pending editor steps in memory. Add a bounded account/instance/document-scoped recovery draft with its base revision and timestamp when practical; never label it an offline database. After reload it is recovery material requiring reconciliation, not an unconditional replacement of server content. Do not auto-replay a stale full body. If durable draft storage is unavailable, clearly show unsaved status and record that limitation.

On a fresh offline launch, the static shell may open but document editing is unavailable in v1. Full offline sessions and explicit merge UX are deferred.

## 7. Files and unified search: protected core

### R2 file lifecycle

Use a private environment-specific bucket, opaque server-assigned keys, and platform-issued grants. An instance namespace is organizational; backend authorization is mandatory on every grant, metadata operation, attachment, and deletion.

Lifecycle: `pending -> uploaded-unverified -> ready -> deleting -> deleted`, with retryable failure states. Exact implementation may combine intermediate states if it preserves these guarantees:

- Request upload: derive identity; check instance access, type/size policy, and quota; create a scoped pending record; issue a short-lived upload grant.
- Browser sends bytes directly to R2 where supported. Show progress, cancellation, and retry without duplicate ready records.
- Finalize: validate the object at the server (existence, actual size, expected metadata; checksum where supported). Client-reported completion is not verification.
- A file becomes attachable/searchable only when ready. Reject attachment of another workspace's or unauthorized instance's file ID.
- Download: authorize against live resource/file access and issue a short-lived URL. Proposed maximum lifetime: five minutes. URLs are bearer capabilities until expiry; do not promise immediate revocation of an already-issued URL.
- Never persist signed URLs as content; persist file IDs. Reissue URLs on demand.
- Treat HTML/SVG/unknown active content as downloads or serve on an isolated file origin with appropriate headers; do not execute uploads on the app origin.
- Remove references transactionally. Delete bytes only when no live references remain; retries and orphan cleanup must not delete a referenced file or race active finalization. Use state/generation checks.

First supported limit: 100 MiB per file; make it a documented adjustable constant, enforce actual server-side size, and test a boundary case. Large multipart uploads are a later extension. No cross-workspace deduplication in v1.

R2 and Convex are separate services: upload confirmation, deletion, and orphan cleanup require reconciliation. The component is useful plumbing, not authorization or a cross-service transaction.

### Search

Global search queries an owner/workspace-scoped Convex search index. Each result includes app/instance title, item title, plain-text snippet, type, and stable resource target. Support filtering to an instance; paginate results. Never search all tenants and filter in the browser.

For recipes and metadata, maintain search entries transactionally with writes. For collaborative note bodies, use snapshots/projections tagged with source version; proposed healthy-online freshness target is five seconds after typing settles. Show eventual search behavior honestly. Concurrent older projection jobs must not overwrite a newer version.

Trash, uninstall, and permission changes must immediately prevent unauthorized search disclosure. The resource resolver checks current lifecycle/access even if cleanup is delayed. Avoid returning stale private snippets by applying live access/lifecycle validation server-side before emitting results. Overfetch bounded batches if filtering removes results; do not scan unboundedly to fill a page.

Search text is data, never rendered as executable HTML. Export and search must not depend on loading a browser editor bundle. File-content OCR and semantic/vector search are later capabilities.

## 8. Shell, design system, routes, and installation

### Shared UI

Build a polished responsive home with app-instance cards/list, global search, recent destinations, and account/preferences entry. Desktop supports navigation beside an app; mobile provides a compact switcher. An app failure has an error boundary and retry route; it must not crash the whole platform.

Provide semantic tokens for background/surface/text/muted/accent/border/danger, typography, spacing, radii, focus, and motion. Support light/dark/system. Shared controls meet keyboard access, visible focus, labels, contrast, reduced motion, and touch targets. Individual apps own layouts and specialized visualizations. App CSS cannot globally restyle the shell; namespace it or use CSS modules.

Theme choice can be cached locally for immediate first paint, then reconciled with account preferences. No theme-flash waiting for network. Use a small approved icon/font set, not a large eagerly imported library.

### Canonical routing contract

Proposed initial routes:

```text
/                                      Palladian home
/w/:workspaceId/a/:instanceId/*         integrated app
/a/:instanceId/*                        standalone app
/a/:instanceId/r/:resourceType/:id      standalone resource link
/account/*                             account and session management
/auth/*                                separately loaded sign-in/recovery UI
```

App definitions may add internal routes but must implement the resource resolver. The integrated equivalent of a resource route preserves the same resource identity. A direct route is not an authorization capability. Preserve a validated internal return destination through sign-in; reject arbitrary external return URLs.

Each instance provides a stable standalone manifest URL, immutable manifest ID, instance name/icon, `start_url` under `/a/:instanceId/`, scope under the same path, and standalone display mode. The platform has its own manifest. Do not use one manifest ID for all app instances or include user credentials in manifests.

The standalone experience hides the persistent global sidebar and launches only the selected app. Include an unobtrusive explicit “Open Palladian” action. Shared tools and account identity remain available. Leaving the PWA scope may open a browser; test rather than promising platform-dependent link capture.

The service-worker policy caches versioned static assets only initially. Never cache auth endpoints, authenticated API responses, or signed file URLs. Keep one centrally owned service-worker strategy with explicit overlapping-scope behavior; apps cannot register competing workers arbitrarily. Updates must not force reload during unsaved editing. Offer an update action and wait for acknowledged saves or preserve recoverable input.

### Custom hostnames

Custom domains are a later v1 phase after standalone paths pass, not a second implementation of the app. A server-controlled verified binding maps hostname -> instance. Domain removal/transfer disables the old binding; Host headers and query parameters cannot create bindings or grant access.

Initial custom-host administration may be operator-managed configuration with documented verification; a self-service DNS wizard is unnecessary. Test with a real authorized test hostname before claiming this phase works. Unknown hosts fail closed. Auth trusted origins, callbacks, cookies, manifests, deep links, CORS, and asset routing must all resolve consistently for each registered hostname. A separately signed-in user still needs access to the bound instance.

Canonical resource identity is hostname-independent. Never copy records for a new hostname. Cross-domain cookie sharing is not a requirement. iOS installs may start with copied cookies or require sign-in; subsequent sessions are independently persistent.

## 9. Optional tools offered by the platform

These services are optional for an app to use, but the following implementations belong to full v1. Keep them out of first-load code until used.

### Scheduler and notification inbox

Use Convex scheduling primitives; do not build a competing job runner. Register typed named operations on the server. A schedule can call only a registered operation allowed for its owning app; no arbitrary code, function path, or URL execution.

Provide one-shot and daily recurring schedules with explicit IANA timezone. Daily wall-clock policy: spring-forward nonexistent time runs at the next valid time that day; fall-back ambiguous time runs once at the first occurrence. Compute using a maintained timezone library and test the two transitions. Store UTC next-run timestamps. More recurrence patterns are later work.

At execution, recheck ownership, enabled state, and schedule generation. Cancellation/edit increments the generation so already-enqueued stale tasks cannot perform work. Use occurrence-level idempotency for notifications/side effects. Persist status, last outcome, and bounded retry/backoff. External delivery is at-least-once unless the receiving provider supports idempotency; never claim universal exactly-once effects.

Ship a shared durable notification inbox with read/unread state and resource links, accessible in shell and standalone modes. Toasts are not durable notifications. OS push/email are extension transports, deferred from v1; do not label inbox delivery as iOS background push.

### Shared file picker/uploader

Provide standard choose/drop/paste, progress, cancel/retry, preview/download, and accessible error UI over the file contract. An app can replace the picker while retaining the same lifecycle and permission checks.

### Voice input

“Whisperflow-like” means press/hold or toggle recording, transcription, editable preview, and insertion into the currently selected target. It does not require the Wispr Flow product or account. Use an injected transcription adapter; select and document the provider at implementation time (existing Cloudflare transcription is a candidate).

Microphone permission is user-initiated. Recording has visible active/cancel states, a bounded duration, cleanup on unmount/target change, and no accidental background recording. Never insert a late transcription into a different note. Backend credentials stay server-side; transient audio is deleted after processing unless the user explicitly saves it. Provider failure leaves typed content intact.

### Deck input

Inspect Deltos's existing Deck and extract only needed reusable pieces with source provenance. No separate public package publication is required. Keep host adapters for focus, selection, editor commands, and transcription separate from keypad UI.

Native input remains functional. Custom input is opt-in and lazy; respect hardware keyboard, IME/composition, selection, undo, safe areas, and iOS viewport changes. One target/command adapter owns transformations; don't register independent markdown rules in the Deck and editor. Require on-device evidence before marking it complete.

## 10. Agent integration and MCP: protected core

### New-protocol-first policy (owner decision, 2026-09-09)

Build with pinned, compatible official TypeScript SDK v2 packages, targeting MCP `2026-07-28`. Explicitly disable legacy protocol handling, including SDK defaults that accept older requests. Do not add v1 SDK dependencies, legacy endpoints, fallback routing, or speculative compatibility wrappers. A package version and a negotiated protocol revision are different: a successful tool call through a fallback does not prove new-protocol support.

Test ChatGPT, Codex, and Claude Code separately, recording the actual product surface/version, supported opt-in configuration, protocol revision observed, discovery, authentication, and tool-call results. Use available documented opt-ins before concluding a client lacks support. Do not infer ChatGPT web behavior from a Codex CLI result.

Legacy support is authorized only when an actual required-client test demonstrates lack of support for the new protocol. First rule out endpoint reachability, auth configuration, incorrect SDK usage, and disabled client opt-ins. Missing documentation, unavailable client access, or a generic connection failure is insufficient evidence; mark these unverified. Document confirmed incompatibility in the phase report and then add only the smallest necessary compatibility adapter, with tests identifying the client and protocol it serves. Keep that adapter separate from domain operations and record the condition for removing it. The existing independent-review checkpoint still applies; no extra permission ceremony is needed for this explicitly authorized conditional fallback.

Removing protocol-level sessions does not remove Better Auth device sessions or OAuth grants. Preserve all auth lifecycle and authorization requirements. Use stable application idempotency keys across transport retries, even when the client assigns a new JSON-RPC request ID.

The platform is useful to agents both when building apps and when using their data. Distinguish developer deployment privileges from runtime user grants. Runtime MCP must never provide arbitrary code execution, schema mutation, deployment, shell, secret access, or unrestricted URL fetch.

Expose a small stable tool set backed by a typed server registry:

- List accessible app instances and their resource types.
- Describe available operations and input/output schemas.
- Search within authorized scope.
- Fetch a current resource and its revision.
- Invoke a registered operation with validated arguments, scope checks, and idempotency key for writes.
- Obtain scoped file upload/download facilities where granted.

These are semantic requirements, not fixed MCP SDK function names. Implement protocol-compatible discovery/errors using the pinned SDK v2 and `2026-07-28` specification under the policy above. Descriptions must make write effects clear. Use the same backend domain functions as the UI so validation, collaboration, file references, and search updates cannot diverge.

Read is the default; writes require an explicitly minted grant. Scope each grant to selected instances and operations. Derive identity from verified credentials. Never trust `userId`, `workspaceId`, or `instanceId` in tool input without checking actual grant coverage. A resource moved or removed from coverage immediately becomes inaccessible. Keep audit metadata (actor, operation, resource IDs, outcome), not full sensitive bodies or tokens.

Begin protocol development with a manually minted revocable token and a real MCP client. Store only an approved hash of a high-entropy credential, reveal the credential once, and isolate its lifetime from browser sessions. This does not complete the final integration: full v1 also requires the OAuth connection flow for ChatGPT, Codex, and Claude Code, with discovery, PKCE, consent, refresh, and individual disconnect tested. Apply the new-protocol-first policy to each client.

Better Auth OAuth/MCP packages are not assumed to be drop-in compatible with the Convex adapter. P5 must prove the exact package/adapter/transport arrangement. Use supported library primitives; if unsupported, produce a concrete alternative for review rather than implementing an OAuth server from memory.

OAuth disconnect/reconnect must not resurrect an old token: bind credentials to a connection generation or equivalent revocable authorization record and check current validity. Concurrent refresh/lost responses must not disconnect unrelated clients. Device logout must leave agent grants alone. Reject arbitrary redirect destinations and unregistered callback origins.

## 11. Performance and operations

The following are proposed engineering budgets, not measured current performance. Record measurements and conditions; do not assert compliance from a screenshot.

- Initial shell's eagerly loaded JavaScript <= 200 KiB gzip, including required auth/client code. If this cannot be met, provide bundle evidence for a reviewer-approved adjustment.
- No editor, voice, Deck, PDF renderer, or inactive app runtime in the initial shell dependency graph.
- Cached-shell first useful paint target <= 500 ms on the owner's iPhone; new network launch target <= 1.5 s on a documented healthy connection. Measure repeated runs and report median/p95, device/OS, cache state, and network.
- Separately record time to authenticated usable data; an empty fast shell does not prove the app is ready.
- Local typing responds without a network round trip. Healthy-online two-client propagation target <= 1 s p95 on the test connection; report server-ack latency separately.
- No recurrent list polling or per-app refresh timers. Bound active subscriptions and clean them up on app switch.

Diagnostic events cover boot phases, auth transition reason codes, operation failures, upload state, collaborative version failures, and schedule retries. Never record credentials, signed URLs, private note bodies, recovery phrases, or audio. Provide a redacted diagnostic export, not a raw browser-storage dump.

Provide environment validation, a reproducible pinned build, a minimal CI suite, release identifiers, and a deployment/runbook for separate dev/staging/prod environments. Record required secret names and owners, never values. Rotate no existing secrets during this work.

Backup/restore must cover both Convex data and R2 objects. A joint application export contains schema/version information, stable resource IDs, file inventory/checksums, and a supported restore procedure. Use fixtures in a disposable restore drill; do not claim a Convex database export alone backs up R2. Prevent restored schedules/notifications from firing until explicitly enabled. Breaking schema changes need forward migration and rollback/restore planning; frontend rollback alone may be insufficient.

## 12. Explicit exclusions and future seams

- Full offline database, offline installation editing, background bidirectional local sync, and automatic offline merge.
- Third-party untrusted app execution, self-service code hosting, runtime bundlers, app store, or independent per-app backend deployments.
- Billing, public signup, team-sharing UI, public anonymous content shares, and custom permissions editor.
- General spreadsheet/formula system, every existing Deltos plugin, OCR/vector search, external connector marketplace.
- OS push/email transport, complex recurrence rules, uploads above the initial limit.
- Migration/retirement of live Deltos, publication of an independent Deck package.

Keep stable IDs, semantic writes, revisions, exports, and adapter boundaries for future extensions. Do not build speculative frameworks for these exclusions.

## 13. Sources and evidence

Local historical evidence:

- `/srv/presidium/projects/deltos/code/brain/RESIDENT-MAP.md`
- `/srv/presidium/projects/deltos/code/brain/working-note.md`
- `/srv/presidium/projects/deltos/code/docs/design/auth-rewrite/auth-overhaul-findings.md`
- `/srv/presidium/projects/deltos/code/docs/design/auth-rewrite/auth-rewrite-plan.md`
- `/srv/presidium/projects/deltos/code/docs/design/palladian-deltos-migration-plan.md`

Primary implementation references, consulted 2026-09-09; reverify against installed versions:

- [Convex architecture](https://docs.convex.dev/tutorial/overview): reactive queries and transactional mutations.
- [Convex offline limits](https://www.convex.dev/sync): temporary disconnections are not full offline persistence.
- [Better Auth React integration](https://labs.convex.dev/better-auth/framework-guides/react): adapter setup and documented package compatibility.
- [Better Auth supported plugins](https://labs.convex.dev/better-auth/supported-plugins): integrations need explicit compatibility checks.
- [Convex JWT integration](https://labs.convex.dev/better-auth/api/convex-plugin): temporary JWT configuration is separate from session lifetime.
- [Authorization readiness](https://labs.convex.dev/better-auth/basic-usage/authorization): Better Auth session readiness and Convex authenticated-query readiness differ.
- [ProseMirror sync source](https://github.com/get-convex/prosemirror-sync): inspect current protocol and persistence before adoption.
- [R2 component source](https://github.com/get-convex/r2): integration plumbing and current capabilities.
- [Workers hosting guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): Workers Static Assets for new frontend hosting.
- [Web app manifests](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest): identity, launch URL, scope, display.
- [WebKit session behavior](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/): installation cookie copying and independent subsequent storage.

The companion execution plan defines phase boundaries and acceptance evidence. Requirements here take precedence over illustrative code in external guides; use supported APIs to satisfy them rather than copying a tutorial's security or lifecycle defaults.
