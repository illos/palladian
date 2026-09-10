# P2 independent review

Status: **P2 accepted for local development on 2026-09-10.** Independent backend source/authorization checks and actual two-browser retained-form/theme/route checks pass. The roadmap may progress to P3 implementation and its separate protected-core checkpoint using development fixtures. This is not approval for production, personal content, hosted P2, physical iPhone readiness or completed file lifecycle.

Reviewer: independent agent `p1_redteam`, which did not implement the P2 backend or host UI. Review follows `AGENTS.md`, the platform specification, P2 and D01–D06 in the execution plan, and the Convex reviewer skill. P1 local-development acceptance is recorded separately at `351cac3`; hosted, iPhone and recovery evidence must not be inferred from this review.

Accepted implementation commit: `a15c488`. The report is committed separately from that implementation checkpoint.

## Design and source findings

The bounded proposal preserves the owner contract. One default workspace per live platform identity is a transactional implementation of the initial private-owner workspace. Actual `instancePreferences` child records make same-definition parent substitution testable in P2 without fabricating Notes/Recipes content. Per-definition create receipts are retained indefinitely, avoiding an unreviewed deduplication expiry window. Future receipt deletion/retention changes require explicit contract review.

All P2 public handlers have argument and return validators. Authentication comes from the existing P1 live-session identity path, and ownership is checked before receipt lookup or returning scoped data. `requireInstance` reads the actual parent and checks the stored workspace, fixed server definition and active lifecycle. Preference mutation verifies both stored parent IDs; preference reads use the instance index and verify the stored workspace. Foreign, mismatched and archived live targets share a bounded `NOT_FOUND` response.

Queries use bounded indexed pagination or unique indexed lookups. No new unbounded collection, global scan with filtering, scheduled public function, arbitrary table/function dispatch or query-local clock was introduced. Numbers used as revisions are nonnegative safe integers with overflow rejection. Preference changes update the child revision and parent preference version atomically while preserving metadata revision/title. Archive increments metadata revision once; repeated authorized archive returns the existing state. A create receipt replay returns its original instance in its current state, including archived state, and cannot overwrite a rename or resurrect an instance.

The scope import rule in `scripts/check-boundaries.mjs` is useful mistake detection, not proof of authorization or a sandbox: importing a helper alone does not prove it is called. Runtime handlers were reviewed separately. The negative boundary fixtures cover missing/type-only/re-exported scope imports, sibling/auth imports, and host-only generated API access. The host allowance is restricted to `src/auth` and `src/platform`; app UI packages still cannot import generated backend or auth internals.

Shared path builders provide stable escaped identity paths. The live backend resolver checks the actual active instance and owner for integrated and standalone presentations. P3 search/file resolution and P4 content-resource resolution remain unavailable. Instance settings are the current route content; this is not evidence of implemented Notes/Recipes content or app collaboration.

No unresolved critical or important finding remains in the accepted candidate. The final host review confirms that inputs retain their original base revision across reactive updates, conflict messages preserve unsaved input, and an explicit load-latest action reconciles the draft. Inputs are disabled during each save so its completion cannot replace newer typing. Mounted references guard obsolete component continuations, including StrictMode setup/cleanup. The private Workspace child is inside the existing identity-keyed auth boundary; the P1 auth lifecycle is unchanged.

## Public endpoint authorization matrix

The 13 new P2 public functions were enumerated from source. Every endpoint rejects an unauthenticated client using otherwise valid generated IDs. Every endpoint accepting scope or an instance rejects a different authenticated owner. Existing P1 identity/session functions and auth HTTP routes retain their separate P1 evidence; `provision.owner` remains internal only.

| Public function | Kind | Live authorization and parent checks |
| --- | --- | --- |
| `platform.workspaces.ensure` | mutation | Live platform identity; transactionally select/create its own indexed workspace |
| `platform.workspaces.current` | query | Live platform identity; owner index only |
| `platform.workspaces.setTheme` | mutation | Live identity and actual workspace owner; expected workspace revision |
| `platform.instances.create` | mutation | Actual owned workspace before scoped receipt lookup; definition literal validator |
| `platform.instances.list` | query | Actual owned workspace; bounded workspace/lifecycle index |
| `platform.instances.get` | query | Actual owned workspace, matching stored instance parent and active lifecycle |
| `platform.instances.rename` | mutation | Same live instance checks; expected metadata revision |
| `platform.instances.archive` | mutation | Same owner and parent checks, explicit archived management path; revision on first archive |
| `platform.routes.resolveInstance` | query | Live identity, fetched actual instance, optional supplied workspace consistency, actual owner and active lifecycle |
| `apps.notes.instances.preferences` | query | Actual owned active Notes instance; indexed child's stored workspace consistency |
| `apps.notes.instances.setPreferences` | mutation | Same fixed Notes checks; exact child instance/workspace parent and child revision |
| `apps.recipes.instances.preferences` | query | Actual owned active Recipes instance; indexed child's stored workspace consistency |
| `apps.recipes.instances.setPreferences` | mutation | Same fixed Recipes checks; exact child instance/workspace parent and child revision |

## Independent execution evidence

`PALLADIAN_TEST_FRONTEND_ORIGIN=http://localhost:5183 node tests/platform/redteam.mjs` passed all nine groups with exit 0 on 2026-09-10. This independently authored harness uses the actual local anonymous Convex backend on 3214/3215, actual Better Auth provisioning/sign-in and Chromium in separate browser contexts. It obtains the actual JWT through the official client and exercises public functions with `ConvexHttpClient`; it does not mock authorization, storage or database transactions. Target checks precede disposable credential submission. Operator fixture output and credentials are suppressed, and fixture sessions are revoked at completion. Fixture workspace/instance/preference metadata remains local development data; there are no file bytes or application content.

1. D01: six concurrent workspace ensures return one workspace, two owners receive distinct workspaces, and the caller's current workspace matches.
2. D01: all 13 P2 public endpoints reject anonymous requests with exact domain `UNAUTHENTICATED`, rather than treating transport errors as denial.
3. D01: all 11 scope-bearing endpoints reject the other owner with exact `NOT_FOUND`; mixed owner/instance parents are denied; forged owner arguments fail framework validation; the protected instance remains unchanged.
4. D02/D03: an owned Notes instance cannot mutate another owned Notes instance's preference row. Notes operations reject Recipes, Recipes rejects Notes, arbitrary table arguments and unregistered definitions fail framework validation, and the untargeted child remains unchanged.
5. D04: eight concurrent creates with one scoped key return one instance; changed payload conflicts; the same key has distinct results for a second owner and a second fixed operation.
6. D05: two simultaneous renames at one base revision yield exactly one success and one explicit conflict. A preference edit preserves the winning title and metadata revision while advancing preference version; stale preference writes conflict. Negative, fractional, NaN, infinite and unsafe revisions are rejected.
7. Pagination: page size one traverses every expected owned active instance without duplicates; another owner's cursor cannot expose foreign rows; invalid sizes and an oversized cursor are rejected.
8. D06: archive removes live get, both route presentations, preferences and rename access. Repeated archive is identical, archived management listing remains owner-only, create receipt replay remains archived, changed replay conflicts, and an unrelated live route still succeeds.
9. Live session boundary: after actual current-device revocation, the still-cached JWT cannot list instances or replay an existing create receipt; the unrelated owner's workspace remains accessible.

The script's domain-denial assertions require an actual `ConvexError` and exact code. Explicit invalid argument tests require `ArgumentValidationError`. Cross-query cursors may either be rejected as cursors or return only the new caller's indexed rows; neither result is counted as broader access.

Independent `pnpm typecheck`, `pnpm lint`, the ten boundary/route unit fixtures and `git diff --check` passed after the final host adapter was completed. An earlier in-progress compile caught an unused adapter variable; the implementation subsequently connected it to the canonical path builder. That transient failure is not counted as a passing check.

The first independent six-group host test failed before its first theme change at `ui.mjs:58`: exact label-text matching could not select the wrapped theme combobox. A temporary diagnostic copy emitted only the failing source line and was removed afterward. An independent Chromium markup reproduction showed exact label matching found zero controls, partial label matching found one and exact accessible combobox-role matching found one. The implementation resolved the ambiguity by supplying an explicit `aria-label="Workspace theme"` on that control, preserving the original exact target and every backend, cross-context and reload assertion. This was a control-label targeting failure, not evidence that theme propagation failed.

The corrected `PALLADIAN_TEST_FRONTEND_ORIGIN=http://localhost:5183 node tests/platform/ui.mjs` then passed all six groups independently with exit 0. This parent-authored test was source-reviewed and executed separately by the reviewer against actual local services in two Chromium contexts. It proved workspace theme propagation and reload, create/list reactivity, exact unsaved draft retention after a stale rename with the server winner unchanged, explicit load-latest and successful retry, retained preference conflict selection, both canonical route identities, active-route/list removal after archive, archived management presentation and immediate private UI removal on signout. No backend, subscription, browser transport or identity was mocked.

The parent separately reports final `pnpm check` (24 unit cases, auth patch source types, production build and bundle gate), formatting, six shell-browser cases and four actual auth-race scenarios passing. These parent runs are attributed evidence, not claimed as independent execution. Final required shell/auth JavaScript is reported as 105,202 gzip bytes; the private Workspace module remains lazy at 2.78 kB gzip. The isolated hosted environment is still pinned to P1 and is not P2 validation.

## Accepted scope and remaining phase boundaries

- D01–D06 are accepted for real P2 workspace, instance, preference and receipt entities, including an actual structured host form. Both users, two workspaces and two same-definition instances were exercised.
- D02/D06 file lifecycle remains P3; app content forms/collaboration remain P4. The current settings prototype is not a usable Notes/Recipes content pilot.
- Hosted P2, physical iPhone/installed PWA and recovery/TOTP remain pending. No production deployment, DNS change, personal-data migration, old-infrastructure deletion or Deltos change is authorized by this review.
- P3 may proceed under the roadmap goal with its own independent design/runtime gates and disposable development object bytes.

No protected-core implementation was written by this reviewer. The reviewer authored the separate adversarial backend harness and this report. No new owner decision or protected-contract change is required for the accepted P2 scope.
