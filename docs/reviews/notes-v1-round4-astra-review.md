# Palladian — independent Astra review, round 4

Date: 2026-10-15  
Commit: **`ddd178bacd390e158a87b2a80f5995729fc49570`**

**Core: NOT ACCEPTED.**  
**Edge: ACCEPTED.**

Two core blockers remain: recovery can still erase independent collaborator edits, and the new structural validator rejects ordinary formatting operations. No edge-specific blocking findings remain. This is scoped implementation review, not complete-v1 acceptance.

## Independent evidence

Reviewed the round-3 report, implementation response, product contracts, and changed code; applied the Convex reviewer checklist. Created the requested detached worktree and installed with `pnpm install --frozen-lockfile`.

| Check                                      | Result                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| Notes-core Node tests                      | 23 passed                                                 |
| Backend Vitest                             | 40 passed                                                 |
| Frontend Vitest / Node tests               | 16 / 14 passed                                            |
| Edge Vitest                                | 64 passed                                                 |
| All four packages' typecheck scripts       | Passed, including backend Convex and edge contract checks |
| Independent adapted/new probes             | Backend 8, frontend/core 22, edge 3 passed                |
| Desktop and mobile-emulated Chromium suite | 40 passed; temporary config used port 5182                |
| Production-build offline suite             | 2 passed; synthetic libraries of 1 and 2,000 notes        |

The **33 independent probes include assertions reproducing defects**. Backend probes use `convex-test` and mocked identities; frontend probes use fake IndexedDB, controlled transport responses, and actual ProseMirror transforms/rebasing. Edge probes retain SQLite concurrency checks and exercise MCP cursor transport through the protocol handler.

**Actual local services:** OAuth/MCP `e2e.mjs` passed all 31 steps. The live Chromium script passed collaboration, reload, interrupted offline recovery, invitation sharing, and revocation cleanup. The Worker consent-browser script passed all eight steps, including agent creation, live library updates, disconnect, and No access. A separate Chromium probe reproduced R4-2 against the actual local backend.

**Unavailable:** a mobile-WebKit attempt failed to launch because host libraries are missing. No physical iPhone or production verification was performed.

## Round-3 findings

| Finding                                   | Status             | Verification                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 — stale query lifts revocation       | **VERIFIED FIXED** | Adapted the actual-Convex stale-subscription probe: the mutation denies access and stale query data cannot lift the fence. Wrong subject, same-timestamp cross-tab revocation, and obsolete account epoch remain fenced. Backend probes verify anonymous denial, subject separation, and grant removal. Fresh authorized rechecks still work. |
| R3-2 — recovery erases collaborator edits | **PARTIALLY**      | Original ASCII reproduction now preserves `ALPHA COLLABORATOR OMEGA`. Emoji and longer text still produce a broad replacement and lose the independent remote edit: R4-1.                                                                                                                                                                     |
| R3-3 — recovery overwrites newer typing   | **VERIFIED FIXED** | Paused origin read, opened note, and newer typing retain the newer draft/export. A closed-note variant with another store's durable update refuses the swap and sends no push. Adopted `created` status survives a later save after reopening the store.                                                                                      |
| R3-4 — malformed nested checkpoints       | **VERIFIED FIXED** | Original 101-step malformed-blockquote batch is rejected with revision unchanged at zero. The prior unsafe-link batch also remains rejected. However, the fix introduces R4-2.                                                                                                                                                                |
| R3-5 — tied pagination truncates          | **VERIFIED FIXED** | Adapted original ten-tie probe reaches every note. Repository tests cover limits 1, 3, and 25 and the cross-notebook trash horizon. Independent MCP probe confirms the opaque three-part cursor passes through unchanged.                                                                                                                     |

## BLOCKING findings

### R4-1 — High: recovery's broad fallbacks still delete independent edits

**Locations:** `packages/notes-core/src/document.ts:180`, `:202`, `:333`; `apps/notes/src/live.ts:541`.

Two independently reproduced cases go through `reconcileCreated`, persisted recovery steps, and actual ProseMirror rebasing:

- Base `😀 Alpha middle Omega`; local changes only `Alpha` and `Omega` to uppercase; collaborator replaces `middle` with `COLLABORATOR`. Recovery produces one broad step and the merged result loses `COLLABORATOR`.
- Base `Alpha ` + 2,100 `x` characters + ` Omega`; local changes only the two endpoint words; collaborator changes a character inside the untouched middle. Recovery again loses the collaborator's text.

The first case counts Unicode code points but uses those counts as ProseMirror UTF-16 offsets. Exact-result verification then falls back to the unsafe broad diff. The second exceeds the LCS budget and explicitly replaces the entire textblock. Reproducing the local snapshot exactly does not prove that these steps preserve concurrent work.

**Fix:** maintain correct ProseMirror offsets and preserve unchanged regions when the fine diff exceeds its budget. If safe ancestry/merging cannot be established, retain an explicit recoverable conflict instead of automatically rebasing a broad replacement.

### R4-2 — High: valid list and quote formatting cannot save

**Location:** `packages/notes-core/src/document.ts:79–85`.

`node.check()` treats each replacement slice node as a complete document subtree. Ordinary `ReplaceAroundStep` wrapping contains an intentionally empty wrapper whose content is supplied by the step's gap. A valid blockquote or list wrapper therefore fails the new check before application.

Independent probes run standard `wrapIn(blockquote)` and `wrapInList(bullet_list)`: the resulting documents pass structural validation, but `applySafeStep` rejects both. A backend mutation probe rejects valid quote wrapping with revision unchanged. In actual Chromium, clicking **Quote** on a saved paragraph displays **“The edit would produce an invalid or unsafe note.”**

**Fix:** validate structural correctness on the applied result, or use validation that understands open slices and replacement gaps. Preserve attribute/security checks and validation of every persisted intermediate revision.

## Remaining release gates

- Fix R4-1 and R4-2 and independently rerun their preserved probes, including real-service formatting.
- Complete browser-level stale-subscription/revocation and recovery-race coverage, plus remaining consent-transfer, permission-reduction, account-switching, and invitation-failure cases.
- Retain physical iPhone/Safari, representative-library performance, large-history, device-recovery, backup/restore, named MCP-client, and remaining v1 gates.

Evidence is preserved at `/tmp/palladian-astra-review-r4-ddd178b/`. `SITE_URL` was restored and independently read back as `http://localhost:5178`. The detached worktree was removed without force; main and notes-core Git statuses are empty. No tracked files, commits, pushes, deployments, or production data were changed.
