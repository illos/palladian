# Palladian — independent Astra review, round 3

Date: 2026-10-15  
Commit: **`f1642b57861a150254e56d6a719fba1fd4729b66`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED WITH REQUIRED FIXES — pagination remains incomplete.**

No edge-specific blocking findings remain. Core privacy, recovery, and history defects still block the combined release. This review does not grant complete-v1 acceptance.

## Independent evidence

Read the round-2 report, implementation response, product direction, and changed code. Applied the Convex reviewer checklist.

| Check                                               | Result                                |
| --------------------------------------------------- | ------------------------------------- |
| Detached worktree; `pnpm install --frozen-lockfile` | Passed                                |
| Notes-core Node tests                               | 20 passed                             |
| Backend Vitest; Convex TypeScript check             | 37 passed; passed                     |
| Frontend TypeScript, Vitest, Node tests             | Passed; 10 passed; 14 passed          |
| Edge typechecks and Vitest                          | Passed; 63 passed                     |
| Adapted independent probes                          | Backend 6, frontend 12, edge 3 passed |

The **21 independent probes include assertions reproducing defects**, alongside positive fix verification. Backend probes use `convex-test` and mocked identities; frontend probes use fake IndexedDB, controlled transport/cache responses, and actual ProseMirror transformations. Edge concurrency probes use SQLite and the actual Worker/provider registration path.

**Actual services:** OAuth/MCP `e2e.mjs` passed against the existing local services, including PKCE, refresh, modern/legacy MCP, authorization denial, and revocation.

**Actual browser:** the live Chromium script passed against the review checkout and existing backend: two-browser convergence, reload, offline recovery, invitation sharing, and access-removal cleanup. Only its backend-directory location was adapted in an untracked copy.

The Worker consent-browser script **did not pass**: it timed out waiting for “Your name”; independent inspection found a blank served `/invite` page. Its cause was not established, so it is not classified as a commit defect. `SITE_URL` was restored to `http://localhost:5178`.

No physical-iPhone or production verification was performed.

## Round-2 findings

| Finding                                  | Result             | Verification                                                                                                                                                         |
| ---------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 — stale summaries lift fences         | **PARTIALLY**      | Original delayed summary/body reproduction is blocked; checks predating another revocation cannot lift it. Cached Convex query results still defeat freshness: R3-1. |
| B2 — incomplete inventory deletes work   | **VERIFIED FIXED** | Grant 501 is included; grant/notebook truncation reports `complete:false`; applying an incomplete snapshot preserves pending work and export.                        |
| B3 — interrupted recovery loses identity | **VERIFIED FIXED** | Failed reads after adoption create only once. Lost push replies retain the exact client ID and steps, producing `Hello!` once. Separate recovery race: R3-3.         |
| B4 — recovery overwrites collaborators   | **PARTIALLY**      | Recovery journals revision 0; the original single-insertion case rebases correctly. Disjoint local edits still erase intervening collaborator text: R3-2.            |
| B5 — unsafe intermediate history         | **PARTIALLY**      | Original 101-step unsafe-link batch is rejected unchanged. Malformed nested content still produces unreadable checkpoints: R3-4.                                     |
| B6 — raceable registration ceiling       | **VERIFIED FIXED** | With 299 atomic reservations, ten concurrent Worker registrations produce one 201 and nine 429 responses.                                                            |
| N1 — equal-timestamp pagination          | **PARTIALLY**      | Three ties paginate; MCP carries timestamp and ID correctly. Ten ties return only three notes: R3-5.                                                                 |
| N2 — expiry cleanup deletes replacement  | **VERIFIED FIXED** | Paused expired read, concurrent replacement, then resumed cleanup: the fresh value survives.                                                                         |

## BLOCKING — new or remaining findings

### R3-1 — High: the “fresh” authorization check can use stale subscription data

**Location:** `apps/notes/src/live.ts:373`

`ConvexReactClient.query()` returns an existing local subscription result when available. Calling it after recording `checkedAt` therefore does not establish a newer server authorization decision.

The probe executed the installed Convex query implementation with a controlled stale subscribed result. After another store revoked the note, `recheckAccess` obtained that result without subscribing for a new response, lifted the persistent fence, and allowed a delayed private body to become readable again. Share/move panels subscribe to this same `notes.get` query.

**Fix:** require an authenticated server round trip demonstrably newer than the revocation, tied to the current account and note-fence generation. A timestamp around a cache-capable query is insufficient.

### R3-2 — High: one recovery diff erases non-overlapping collaborator edits

**Location:** `apps/notes/src/live.ts:526`

Comparing revision 0 with the entire local document collapses multiple local edits into one replacement spanning the unchanged text between them.

Verified example, preserving block IDs:

- Base: `Alpha middle Omega`
- Local edits: `ALPHA middle OMEGA`
- Collaborator independently changes `middle` to `COLLABORATOR`

Recovery correctly journals on revision 0, but actual ProseMirror rebasing produces **`ALPHA middle OMEGA`**, silently deleting the collaborator’s independent change.

**Fix:** preserve and rebase the original separate local steps, use a merge that preserves unchanged regions, or retain an explicit conflict when ancestry cannot be recovered safely.

### R3-3 — High: background recovery overwrites newer local typing

**Location:** `apps/notes/src/live.ts:538`

Recovery retains its original draft across the asynchronous history read, then unconditionally writes a journal derived from that older snapshot.

Probe: begin recovering `Hello!`, pause the history response, open the note and persist `Hello! newer typing`, then resume recovery. Both the stored draft and recovery export regress to **`Hello!`**. Reloading can therefore lose the later typing.

**Fix:** atomically compare the current draft with the snapshot being converted before replacing it. If it changed, restart from the latest draft or defer to the active editor. Preserve the newer snapshot throughout.

### R3-4 — Medium: malformed nested content still poisons checkpoints

**Locations:** `packages/notes-core/src/document.ts:75`; `apps/notes-backend/convex/documents.ts:216`

Inserted fragments receive attribute checks, but their nested document structure is not validated at each revision.

A 101-step batch inserts a blockquote containing an invalid direct text child, retains that structure through checkpoint 100, then restores a valid document at 101. The mutation succeeds and current content remains readable, but **history reads at both revisions 100 and 101 fail** with invalid-content errors.

**Fix:** validate complete intermediate document structure, or provide equivalent recursive validation that handles all step forms. Checkpoint serialization must enforce structure as well as size.

## NON-BLOCKING — required fix

### R3-5 — Medium: larger timestamp ties still truncate pagination

**Location:** `apps/notes-backend/convex/library.ts:266`

The query takes `limit * 2 + 1` rows before applying the ID cursor. Subsequent pages repeatedly examine the same leading tied rows, eventually filter them all out, and report exhaustion.

With ten equally timestamped notes and `limit:1`, the probe receives **three notes**, then a null continuation cursor. MCP’s cursor encoding is correct but inherits this omission.

**Fix:** apply a continuation matching the database ordering before limiting, or scan additional backend pages until the requested continuation is exhausted.

## Remaining release gates

- Fix R3-1 through R3-4 and rerun the preserved probes; resolve R3-5 before release.
- Exercise the precise stale-subscription, cross-tab revocation, and recovery-interruption cases in browsers.
- Complete Worker consent-browser verification and the outstanding consent-transfer, permission-reduction, account-switching, and invitation-failure scenarios.
- Retain physical iPhone/Safari, representative-library performance, large-history, device-recovery, backup/restore, named MCP-client, and remaining v1 gates.

Probes and logs are preserved at `/tmp/palladian-astra-review-r3-f1642b5/`. Temporary files were removed, both Git statuses were empty, Vite was stopped, and the detached worktree was removed without force. No tracked files, commits, deployments, or production data were changed.
