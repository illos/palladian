# Notes foundation implementation evidence

Date: 2026-09-29. Scope: first notes foundation and disposable technical proofs, authorized by the owner with sub-agents and independent Astra auth/sync review. **Not complete v1 or production acceptance.**

## Base and implementation

Specification baseline: `7d7e24e054a7b82afe396442c10676e48a785d2a`. Implementation snapshot: `d9a37069112b4fadf096b9383656b0497f50dea5`; subsequent documentation, mechanical formatting and CI wiring record the final review without changing the reviewed contracts. UI/cache and services were developed in isolated branches/worktrees and merged into the parent foundation branch. An early services scaffold commit landed on local main inadvertently; it was retained in foundation ancestry, never independently pushed to main, and introduced no production change.

## Result

The notes UI renders before authentication initialization. It reads account-scoped IndexedDB summaries for the library and only the selected note body. Session/token work runs independently: errors, deadlines and expiry preserve cached viewing; they do not implicitly sign out or erase notes. Explicit logout intent survives reload and failed remote sign-out. Known revocation, account transitions and cross-tab invalidation fence callbacks and cache writes. The real adapter currently reports expiry, not authoritative device revocation.

The continuous ProseMirror editor loads after cached plain text. New local drafts can begin during authentication. `#HEADER` followed by Tab creates a heading; selection can span paragraphs. Failed rich-editor loading preserves formatted recovery documents instead of flattening them. Draft writes are ordered and separate from accepted snapshots. Latest in-memory snapshots survive quota failures while the window remains open and are available for navigation and explicit recovery export. This memory fallback cannot survive closing a window when storage failed.

Logout offers wait, export, explicit discard and cancel. Starting a download is not treated as a successful export: a separate saved-file confirmation is required. Waiting retains the drafts; actual server saving is not yet integrated. Access invalidation prevents exporting old private content.

The production service worker caches only build-owned public assets, including the shell, editor and manifest; it never caches API/auth responses. Asset contents and manifest participate in versioning. Old caches retire on normal activation; no immediate worker takeover is requested. Existing cached notes reopen with the network completely unavailable. Comprehensive PWA update/install acceptance remains pending.

## Changed areas

| Area | Purpose |
| --- | --- |
| `apps/notes/` | Responsive notes surface, session controller, official deferred auth adapter, indexed display cache, draft recovery, lazy editor, offline shell |
| `spikes/notes-services/` | Isolated local Convex/Better Auth and ProseMirror component proofs; no production target |
| `tests/browser/notes-*.spec.ts` | Browser storage, stale-response fencing, draft recovery, editor failure and production offline checks |
| Root dependency lock/workspace and browser config | Pinned dependencies; separate notes checks from the shelved platform suite |
| `AGENTS.md`, specification README, review documents | Owner authorization, evidence, limits and independent review |

No Deltos writes, real-note import, DNS, production Worker/R2 deployment, reset emails or external-agent messages occurred. The historical platform shelf remains intact.

## Evidence

| Check | Environment and result |
| --- | --- |
| Session controller | 14 Node tests passed; controlled clocks, service responses and cleanup callbacks. Astra independently reran them. |
| Frontend/tool/browser-source types | Strict TypeScript passed, without skipped declaration checks. Production build and the repository formatting check passed. CI now includes notes type, controller, Chromium and production-offline checks; the remote CI run is not yet claimed. |
| Backend types | Genuine CLI-generated ignored Convex types; strict checks passed with `skipLibCheck:false`, explicit Node/Bun types. |
| Integrated UI/cache/editor | 32 checks passed across desktop and mobile Chromium; includes pending/failed draft recovery, same-account activation, logout export/cancel and cross-tab invalidation. Mobile retry is invoked through the development controller harness while its library control is hidden. |
| Offline production shell | Real production preview, service worker and IndexedDB; one and 2,000 synthetic small notes reopen with all network unavailable. No production fixture harness. |
| Actual auth in browser | Chromium against real loopback Better Auth: password form, persisted session/account across reload, retained draft during injected HTTP 503, reconnect without sign-in, cached titles visible while actual auth requests are held pending. Implementer executed this proof; Astra inspected it. |
| Actual auth/token backend | Real local Convex/Better Auth, random disposable accounts. Original five-second fixture token rejected after observed grace, renewed token accepted from the retained session. Public signup and anonymous protected reads rejected. Astra independently reran the probe. |
| Actual collaboration backend | Two authenticated humans and a trusted fixture agent against the real ProseMirror component: competing steps/rebase converge, receipt replay is idempotent and payload-bound, history authorization enforced, cancelled/stale claims rejected, order-only claim bypass and non-document roots rejected. |
| Safari/WebKit/physical iPhone | Not performed. Installed WebKit cannot launch on this host because runtime libraries are missing. Chromium viewport emulation is not an iPhone test. |

Commands are in [app README](../../apps/notes/README.md) and [services README](../../spikes/notes-services/README.md). The backend runs only on loopback ports 3218/3219; secrets and generated data are ignored and never recorded here.

## Launch measurements

A single desktop production offline observation with 2,000 cached small notes initially took 641.8 ms to display the library because all rows were mounted. Limiting initial rendering to 60 rows, with incremental scroll/button loading, reduced the same observation to **63.3 ms for titles and 118.1 ms for selected text**. All cached summaries remain searchable; the production probe verifies finding a note beyond the initial window. One-note observations after the change were 38.3 ms and 99.5 ms respectively. The final repeat, including the beyond-window search assertion, passed at 65.9/128.6 ms for 2,000 notes and 39.1/97.0 ms for one note. These include automation overhead and warm browser storage; they are neither physical-device cold-process measurements nor p95 acceptance.

The unconfigured production launch bundle is about 107 KB gzip, with the rich editor in a separate 66 KB gzip chunk and logout controls in a separate small chunk. A configured auth build may contain additional deferred/shared chunks. Browser-auth development observations around 200 ms are not production budget evidence.

## Remaining gates and next slice

Astra accepted the tested foundation, not the complete release; see [its separate report](notes-foundation-astra-review.md). G01–G05 remain open where their full product behavior has not been demonstrated.

The next slice should connect the browser editor to authoritative steps, receipts and reactive updates, then prove cache-to-live handoff, lost-response recovery and two-browser collaboration without disturbing launch or selection. Server notebook/note permissions, full rich schema, complete history restoration/retention, file lifecycle, reminders, invitations/reset email and real MCP agent credentials/clients remain unimplemented. The proof uses a paragraph-only 100 KB schema and conservative one-paragraph claims; those are experiment limits, not accepted product contracts. Trusted fixture agents are not production MCP authentication.

Actual device-revocation signaling, multi-tab token renewal, credential/account response races in browsers, long-lived elapsed sessions, full logout-save behavior, PWA update lifecycle and physical iPhone 15 Plus launch/editor measurements remain pending. No production deployment is authorized by this report.
