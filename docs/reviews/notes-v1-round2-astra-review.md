# Palladian — independent Astra review, round 2

Date: 2026-10-15  
**Core: NOT ACCEPTED. Edge: NOT ACCEPTED.**  
Commit reviewed: **`9a6e935abeabde312ea2a84aa7d0096b5015cd15`**

Most round-1 defects are corrected in their original scenarios. Adversarial probes verified remaining privacy, persistence, history, and registration-control defects.

## Independent evidence

Read both round-1 reports, the implementation response, relevant specifications, and changed code. Applied the Convex reviewer checklist.

Commands run in the detached review worktree:

| Directory             | Command                                                                   | Result                  |
| --------------------- | ------------------------------------------------------------------------- | ----------------------- |
| Repository            | `pnpm install --frozen-lockfile`                                          | Passed                  |
| `packages/notes-core` | `node --experimental-strip-types --test tests/*.test.ts`                  | 20 passed               |
| `apps/notes-backend`  | `npx vitest run`                                                          | 34 passed               |
| `apps/notes-backend`  | `npx tsc --noEmit -p convex/tsconfig.json`                                | Passed                  |
| `apps/notes`          | `npx tsc --noEmit`                                                        | Passed                  |
| `apps/notes`          | `npx vitest run`                                                          | 5 passed                |
| `apps/notes`          | `node --experimental-strip-types --test tests/*.test.ts`                  | 14 passed               |
| `apps/notes-edge`     | `pnpm typecheck`                                                          | Passed                  |
| `apps/notes-edge`     | `npx vitest run`                                                          | 61 passed               |
| Backend/app/edge      | Targeted `npx vitest run` commands for temporary `astra-r2.test.ts` files | 3 / 8 / 2 probes passed |

The 13 additional probes include positive verification and assertions reproducing defects. They reuse round-1 fixtures and adapt the cache/token probes, with additional interruption, concurrency, pagination, and checkpoint cases.

Backend tests use `convex-test` and mocked identities. Frontend probes use `fake-indexeddb`, controlled transport responses, and real ProseMirror transformations. D1 probes execute SQL through Node SQLite, including the actual Worker/provider registration path.

**Actual services:** ran `node scripts/e2e.mjs` with `NOTES_BACKEND_DIR` pointing to the existing local backend. Passed OAuth/PKCE, refresh, modern and legacy MCP, note operations, authorization denial, and revocation. Existing services were not redeployed. No browser, physical-iPhone, or production checks were independently performed.

Probes are preserved at `/tmp/palladian-astra-review-r2-9a6e935/`. Removed temporary probes, verified empty `git status --porcelain`, and removed the detached worktree without force. No tracked-file changes, commits, pushes, deployments, or environment changes.

## Round-1 findings

| Finding                                    | Result              | Verification                                                                                                                                                      |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 1 — unsafe raw attributes             | **PARTIALLY FIXED** | Unsafe creation and final image-step documents are rejected; rendering filters URLs. Intermediate checkpoints remain unsafe: B5.                                  |
| Core 2 — token/account binding             | **VERIFIED FIXED**  | Different-subject token rejected with session recheck. Additional probes reject changed generations and superseded requests.                                      |
| Core 3 — access-loss cleanup               | **PARTIALLY FIXED** | Original late-body and cross-store export probes now reject access. Delayed summaries undo the fence: B1. Open-note closure handlers are wired.                   |
| Core 4 — shared-note reconciliation        | **PARTIALLY FIXED** | Atomic access query and ordered reconciliation handle ordinary removal/retained-sharing cases. Truncated snapshots delete authorized work: B2.                    |
| Core 5 — late search results               | **VERIFIED FIXED**  | Inspected effect cleanup, account/generation completion checks, and account/generation rendering filter. No independent browser race test.                        |
| Core 6 — creation replay authorization     | **VERIFIED FIXED**  | Backend regressions reject both native and Markdown creation replays after access loss.                                                                           |
| Core 7 — consent permission reduction      | **VERIFIED FIXED**  | Reconnect removes membership and future sharing; later notebook receives no grant. UI submits explicit choices.                                                   |
| Core 8 — revoked invitation completion     | **VERIFIED FIXED**  | Wrong claim and claim→revoke→complete rejected. Inspected expiry/email checks and failed-account cleanup. Cleanup failure handling was not fault-injected.        |
| Core 9 — double replay on reopening        | **VERIFIED FIXED**  | Base-document initialization plus one pending-step replay produces `Hello!`; verified App wiring.                                                                 |
| Core 10 — lost creation response           | **PARTIALLY FIXED** | Successful reconciliation preserves later typing. Interrupted reconciliation duplicates work and can overwrite intervening edits: B3–B4.                          |
| Core 11 — truncated history replay         | **VERIFIED FIXED**  | Revision 650 within the 701-revision batch matches full replay; inspected checkpoint boundaries and continuity checks. Separate unsafe-checkpoint regression: B5. |
| Core non-blocking — separator replacement  | **VERIFIED FIXED**  | Core regression merges adjacent paragraphs into `one two`.                                                                                                        |
| Core non-blocking — recent pagination      | **PARTIALLY FIXED** | Filtered-page regression passes; equal timestamps still cause skipped notes: N1.                                                                                  |
| Edge 1 — name-based identity reuse         | **VERIFIED FIXED**  | Backend rejects different-client reuse without transfer. UI matches client IDs, requires transfer confirmation, and renders identity/loopback warnings.           |
| Edge 2 — ignored permission reductions     | **VERIFIED FIXED**  | Same backend and UI evidence as Core 7; retained grants/delegations are disclosed.                                                                                |
| Edge 3 — unbounded registrations           | **PARTIALLY FIXED** | Limiter configuration and abandonment purge added; purge test passes. Claimed exact ceiling is non-atomic: B6.                                                    |
| Edge 4 — retirement beyond historical rows | **VERIFIED FIXED**  | Indexed active-connection regression retires the prior connection despite 120 historical rows.                                                                    |
| Edge 5 — concurrent consent consumption    | **VERIFIED FIXED**  | SQLite-backed concurrent `take` has one winner; backend rejects sibling redemption and approval after consumption. Local service rejects request-key reuse.       |

## BLOCKING — new or remaining defects

Paths below are relative to the repository.

**B1 — High: stale summaries resurrect revoked content.**  
`apps/notes/src/cache.ts:497`

Every incoming summary unconditionally deletes the persistent revocation marker. Probe: capture fence → cache note → revoke → apply delayed old summary using that fence → apply delayed old body. The private body becomes readable again. Account epochs do not distinguish note-access generations; delayed feed work or another tab can supply the stale summary.

**Fix:** version note-access decisions and reject stale summaries/bodies. Lift revocation only on a demonstrably newer authorization result.

**B2 — High: an incomplete access snapshot deletes authorized pending work.**  
`apps/notes-backend/convex/library.ts:56`; `apps/notes/src/cache.ts` (`reconcileAccess`)

`sharedSummaries` reads only 500 grants, including denied grants, but its result is treated as complete. A backend probe with 500 preceding denied grants confirmed that an accessible 501st note is absent from `library.access`. A cache probe confirmed that absence deletes the cached note and pending draft and prevents export.

**Fix:** provide a complete authorization inventory, or explicitly paginate/version it and postpone destructive reconciliation until completion. Truncation must never imply revocation.

**B3 — High: interrupted creation reconciliation loses retry identity.**  
`apps/notes/src/live.ts:420`, `:480`, `:499`

Two verified failures:

- After ID adoption, a failed content read leaves an uncreated draft under the server ID. The next sync uses that ID as a new creation key. The probe observed keys `local-first`, then `server-1`, producing a second note.
- If the diff push commits but its response is lost, fallback journals the same step under a **different client ID**. Reopening and receiving the accepted step produces `Hello!!` from intended `Hello!`.

**Fix:** persist immutable creation identity, server-ID adoption state, and the exact step/client identity before sending. Recover uncertain outcomes through the accepted log using that identity.

**B4 — High: creation recovery overwrites intervening collaborator edits.**  
`apps/notes/src/live.ts:472`

Recovery computes a diff from the **current server document** to the stale local draft and submits it at the freshly fetched revision. A probe changed server text `Hello collaborator` to local `Hello!`, then removed recovery. The collaborator’s change was silently erased.

**Fix:** retain the original creation base and subsequent local steps. Rebase those steps over accepted changes, or preserve an explicit conflict when ancestry cannot be established.

**B5 — Medium: safe final batches persist unsafe, unreadable checkpoints.**  
`apps/notes-backend/convex/documents.ts:164`, `:175`, `:206`

Validation checks only the final document. A 101-step probe applied an unsafe link through revision 100 and removed it at 101. The batch succeeded and current content was safe, but checkpoint 100 contained the unsafe URL. Reading **both revision 100 and revision 101** then failed validation.

**Fix:** validate every persisted revision/checkpoint, including size constraints. Reject batches whose intermediate states violate the historical-document contract. This probe establishes broken history, not executable XSS.

**B6 — Medium: the “exact” registration ceiling is raceable.**  
`apps/notes-edge/src/index.ts:145`

Admission counts registrations separately from insertion. Starting with 299 registrations, ten concurrent requests through the actual Worker/provider path all returned 201, leaving **309**. The per-address limiter does not serialize requests from different addresses.

**Fix:** atomically reserve hourly capacity in D1 before provider registration, with defined failure/refund handling, or enforce admission and insertion in one transaction.

## NON-BLOCKING

**N1 — Medium: recent pagination skips equal timestamps.**  
`apps/notes-backend/convex/library.ts:242`, `:267`

Three notes created at the same timestamp, queried with limit one, returned one note followed by an empty page. Strict timestamp-only continuation skips the other two.

**Fix:** use a stable compound cursor including a unique tie-breaker.

**N2 — Medium: expiry cleanup deletes a concurrent replacement.**  
`apps/notes-edge/src/d1-kv.ts:71`

A controlled SQLite probe paused `get` after reading an expired value, wrote a fresh replacement, then resumed. The unconditional deletion removed the fresh value.

**Fix:** condition deletion on the row still being expired, or filter expiry during reads and leave deletion to a conditional sweep. Normal expiry, metadata, prefix/cursor listing, and atomic consumption tests passed.

## Remaining release gates

- Resolve B1–B6 and independently rerun the preserved probes, including actual browser interruption and multi-tab revocation scenarios.
- Independently verify consent transfer, reconnect permission reduction, account switching, and invitation cleanup under failures in browsers.
- Complete physical iPhone/Safari, representative-library performance, large-document/history, recovery/device-revocation, and backup/restore proofs.
- Exercise the named real MCP clients and Presidium path; SDK success does not establish those integrations.
- Remaining v1 capabilities and production configuration/security evidence retain their existing gates. This review grants no complete-v1 acceptance.
