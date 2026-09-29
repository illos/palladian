# Notes foundation — independent Astra review

Date: 2026-09-29. Reviewer: Astra, independent of the auth, cache/editor, and service implementers.

Status: **accepted for the tested foundation slice, with release gates open**. No unresolved blocking source finding remains in the reviewed foundation. This is not approval of a complete notes app, production deployment, or G01–G05.

## Scope and evidence

Reviewed implementation snapshot: **`d9a37069112b4fadf096b9383656b0497f50dea5`**. Review covers `apps/notes/src/session.ts`, `main.tsx`, `auth-service.ts`, `SignIn.tsx`, `cache.ts`, `App.tsx`, `logout.ts`, the editor/offline-shell modules, their regression tests, and the isolated `spikes/notes-services` backend/probe. Services review included `5254212` and canonical-root fix `f124c86`. Final source inspection includes bounded initial list rendering, quota-failed recovery across navigation and same-account activation, final export fencing, and strict backend library typechecking.

The review applied the Convex reviewer checklist to the new backend: authenticated identity, ownership/effective edit checks before data and receipt access, server-side step validation, bounded query results, validators, and component mutation boundaries. Historical platform code and its prior acceptance are not acceptance of the notes app.

Independently executed:

- `node --experimental-strip-types --test apps/notes/tests/session.test.ts`: **14 passed**. These use controlled services, clocks, hints, and cleanup callbacks; they prove controller behavior, not real browser credential renewal.
- The `spikes/notes-services/prove.mjs` HTTP/component probe against the disposable loopback Convex backend: **passed**. This exercised actual password sign-in, session persistence, protected queries, access-token expiration/renewal, two authenticated human clients and a trusted fixture agent, ProseMirror rebasing, receipts, claims, cancellation, history reads, and revoked-access rejection. It used synthetic accounts and content, not production data.
- Final controller rerun after the later integration changes: **14 passed** again.

Reviewed test source and implementation-reported execution evidence:

- Integrated development browser suite: **32 passed, no skips**, across desktop Chromium and Chromium with an iPhone 15 Plus viewport. It covers cached launch with stalled auth, immediate drafts, transient errors, explicit expiry/revocation fixtures, account/cache fencing, quota-failed and queued recovery, retry continuity, editor-chunk failure, preserved rich drafts, and logout/export settlement.
- Actual Chromium form/session probe against the disposable auth service: password sign-in, reload with the same account/session, local draft persistence, injected HTTP 503 preserving cached content, reconnection without a second sign-in, and cached content visible while real auth requests are held pending. The recorded development reload-to-title observation of 198 ms is a single local run, not a production or iPhone budget.
- Production offline-shell browser probe: a cached library and selected cached note remained available after all network access was disabled; the production fixture harness was absent and cached requests were restricted to public build assets. With 2,000 small cached notes, the parent observed 641.8 ms to the visible library when rendering every row, then 63.3 ms after limiting initial rendering to 60 rows; selected text appeared at 118.1 ms from navigation start. The one-note observation was 38.3 ms for the library and 99.5 ms for selected text. These are individual desktop Chromium observations including automation overhead, not p95 or physical-device measurements. The repeat probe additionally searches for note 1999 and verifies its body; final execution is recorded in the implementation report.
- Typechecking and production build checks are recorded by the implementers. WebKit execution is blocked by missing host libraries; physical iPhone and Firefox checks remain pending. Chromium viewport emulation is not Safari or an actual iPhone.

The token experiment observed a five-second fixture JWT still accepted at approximately 6.5 seconds and rejected at approximately 71.5 seconds, then renewed successfully from the retained session. This bounds observed expiration grace; it does not establish its exact configured duration or prove a year of elapsed session use.

Chords could not identify this sub-agent session (`Ambiguous provider session; cannot select a Chords project`). Parent/sub-agent coordination used the task collaboration channel. No credentials or private content are included here.

## Findings resolved during review

| Severity | Finding and consequence | Resolution/evidence |
| --- | --- | --- |
| High | `session.ts`: aborting a hung sign-out transport did not settle its promise; logout could remain pending forever. | An explicit deadline now bounds the awaited operation, including adapters that ignore abort. Targeted controller regression passes. |
| High | `session.ts`: an in-flight account check could change identity while logout awaited unsaved-work preparation. | Logout fences prior requests before preparation. A deferred A-to-B response cannot change the account being settled. Targeted regression passes. |
| High | `session.ts`: retry could bypass failed prior-account cleanup; reload could expose the old account hint and forget cleanup. | Pending cleanup is retained across retries and persisted in a hidden hint before clearing. Failed-cleanup/reload regressions pass. |
| High | `cache.ts`: per-instance epochs did not prevent delayed responses or another tab from reopening cleared data. | Persistent account epochs and a shared activation epoch are checked inside IndexedDB transactions. Request-time cache fences, immediate invalidation, and guarded account activation reject stale work. Browser regressions exercise these boundaries. |
| High | `main.tsx`/`session.ts`: another tab could overwrite explicit sign-out intent with a late ready response. | Storage/invalidation events fence its controller; signed-out/revoked state cannot be reopened by passive retry. Targeted controller regression passes. |
| High | `SignIn.tsx`: a late sign-in callback could call retry after logout or another account transition. | The callback captures controller generation and ignores stale completion; intentional successful sign-in uses an explicit retry path. Actual browser response-ordering remains a separate gate. |
| High | `App.tsx`: same-account retry reset the open editor/list because request generation was also used as display identity. | Display continuity now follows account/access state, while async results retain fences. The browser suite covers retry followed by further draft typing and save feedback. |
| High | `notes.ts`: comparing paragraph content by ID ignored paragraph order, allowing an unchanged claimed paragraph to be moved. | Ordering participates in affected-paragraph validation; the actual-service regression rejects the bypass. Conservative structural-scope limits remain below. |
| High | `notes.ts`: an agent could omit its cancelled claim because principal kind was not trusted server state. | Guarded internal fixture provisioning now records principal kind; agent writes require a claim. Actual-service late-generation and omitted-claim regressions pass. Real MCP principal registration remains pending. |
| High | `EditorSurface.tsx`: editing a recovered rich draft in the plain fallback reconstructed it as plain paragraphs and lost formatting/objects. | Editable fallback is restricted to structurally plain drafts; formatted recovery drafts remain readable and retain their JSON until the editor is available. A blocked-editor heading/bold preservation regression was added. |
| High | `cache.ts`/`logout.ts`: queued or quota-failed typing could be omitted from logout detection/export, and navigation could reload an older stored draft. | Latest recovery snapshots are captured synchronously, overlaid under persistent account fences, and merged after queued writes settle. Export checks access again after asynchronous work. Connecting drafts survive same-account activation; invalidation clears memory. Integrated regressions pass. |
| Important | `notes.ts`: a valid ProseMirror text node could pass document validation because child-ID checks were vacuous. | Canonical document-root identity is now required before persistence. Independently reproduced the underlying validation hole; the service implementer added an actual rejection regression. |
| Important | `offline-plugin.ts`: hashing asset names alone could leave an HTML-only change on the old cache version. | Emitted contents now participate in versioning; normal worker activation retires prior shell caches. API, authenticated, and query-bearing requests do not enter this shell cache. |
| Important | Token-renewal evidence initially proved only issuance of a newer JWT. | The actual-service probe now proves rejection of the original token after observed grace before accepting renewal. |

## Foundation limitations

Voluntary logout now offers wait, export with a separate saved-file confirmation, explicit discard, and cancel. Initiating a download alone never settles logout. Server saving is unavailable in this foundation and the wait action states that limitation. End-to-end save-before-logout acceptance therefore remains part of server integration. Export is a recovery JSON file, not yet a complete import/restore workflow.

Browser storage can fail or be evicted. The foundation preserves accessible failed typing in memory for navigation/export and does not label it durable; this cannot survive browser termination if storage never accepted it. Offline worker behavior has a production Chromium proof, but update behavior across installed Safari PWA versions still needs actual-device evidence.

## Release gates that remain open

The local display architecture follows the owner's north star: an account-scoped summary index and one-note body reads are independent of session checks; pending drafts and accepted snapshots are separate. The offline Chromium probe supplies initial asset/cache evidence. Representative-library repeated measurements and physical iPhone 15 Plus installed-PWA testing remain pending. The provisional 500 ms p95 target is not accepted by an empty-shell metric, a single local observation, or development fixtures.

`App.tsx` filters the full summary index before slicing the rendered rows. Initial display renders 60 rows; scrolling or an accessible “Show more notes” button adds 60 more. Search remains available across all cached titles/previews, including rows outside the initial rendered window. This fixes the measured large-library rendering cost without loading every document body on launch. It is incremental rendering, not a claim of full list virtualization or full-text server search.

G03 remains open. Null Better Auth session results are correctly treated as expiry, preserving cache; the real adapter does not yet receive an authoritative device-revocation signal. Multi-tab token renewal, actual account-switch/credential response races, invitation verification, Cloudflare reset-email delivery, reset-driven device revocation, agent keep/disconnect choices, and elapsed long-lived session behavior require separate evidence.

G02 remains open. The real component probe uses a paragraph-only schema, a 100 KB document guard and 32-step batches as experiment bounds. UI editing and server collaboration are not an accepted integrated path. Durable pending existing-note operations, lost-response browser recovery, cache-to-live selection handoff, full rich objects, multiple-paragraph claims, atomic claim release, live interruption delivery, and history restore are pending. Absolute paragraph index in the proof's claim comparison conservatively blocks some unrelated insertions before a claim; it is not accepted as precise necessary-scope structural editing. A snapshot per accepted batch is not proof of efficient lifetime history. Authorization precedes receipt replay and changed request payloads are rejected in the tested backend.

The experiment's trusted fixture agent demonstrates server-enforced claim requirements, not real MCP authentication or client compatibility. Notebook/note overrides, read-only history denial across the full access model, actual target MCP clients, attachment lifecycle, long-history cost, backups, and restore remain outside this foundation's acceptance.

## Final disposition

Accept the reviewed local-display/recovery foundation and disposable auth/sync proofs for continued implementation. The addressed findings have source fixes and targeted evidence. Keep existing notes read-only until the real collaboration readiness contract is integrated; do not infer app-level server-save acceptance from the component probe. Protected production auth/sync changes still require the remaining gates and independent review.
