# P1 implementation — identity, sessions, startup

Initial report: 2026-09-09. Correction update: 2026-09-10. **P1 is independently accepted as the local foundation for P2 (`351cac3`). A07 corrections and the corrected full-duration A03 test pass. Hosted adoption, physical-device evidence, recovery and real-data use remain pending.** The original findings below are historical evidence; read the correction addendum and separate `P1-review.md` for current status. This is an implementation report, not independent approval.

## Phase and base/head commits

Assigned scope: P1 only. Base: `147a8834dc8e7a6b6e577b6bbd2f5dcf08d6bb68` (P0 correction acceptance). Implementation commits: `f61a6a21d0083cf3c7f6a92ea7ba351921d16b33` (P1 candidate) and head `970d94145f3b7b3a382fb75c0eee1c7bd9b03f8b` (strict declaration compatibility, configuration guards and final lifecycle evidence). This report is a subsequent documentation-only commit. Owner's pre-existing edits to AGENTS.md and the three handoff/spec documents are preserved and excluded from implementation staging. Read the current workspace specification as well as the committed diff.

Read the full platform specification, execution plan, ADR 0001, P0 implementation evidence, original independent review and its correction acceptance before implementation. Used Convex/expert/deployment-guard skill guidance and pinned installed package sources. No independent-review file was written and no protected-core self-approval was made.

## Outcome and user-visible behavior

Implemented an actual root Convex backend, operator-only private owner provisioning, transactionally stable platform identity, official browser sign-in/out, paginated session list/revoke, auth readiness/retry UI, and redacted diagnostic export. The themed shell and app registry render independently of the auth region. Account/sign-in UI is lazy. Device-session expiry remains 365 days with daily sliding and 900-second JWTs. Every protected operation checks the live server session.

The priority was proving the official browser lifecycle before account UI polish. That proof found two local lifecycle blockers:

1. **High — A07 delayed successful renewal from account A can overwrite account B's credential after logout and switch.** The regression completes A's sliding renewal on the server, holds its response, signs A out and B in through the real browser UI, releases A's old response, then asserts the official client still resolves B. It fails. A's server session remains revoked; this does not demonstrate an authorization bypass or private-content leak, but it can destroy the newer local sign-in state. The pinned adapter writes response cookies into the current jar without guarding the request's session generation.
2. **A03 — automatic resume failed in the corrected production desktop freeze probe.** After actual JWT expiry plus verifier tolerance, the old token was denied. The page resumed without navigation, but no token response was observed and no distinct unexpired token appeared during the full 30-second observation window. This proves the local automatic-resume gate failed; it does not isolate a library versus integration root cause or establish phone behavior. No custom refresh lifecycle was added.

The A07 regression retains its success assertion and still fails. Strict declaration compatibility was corrected without runtime changes or weaker checks. No runtime auth patch, custom rotation, proxy, weaker acceptance assertion, forced OAuth dependency, wildcard origin or disabled CSRF was added to make the lifecycle gate pass. [ADR 0002](../decisions/0002-p1-identity-sessions-recovery.md) contains a concrete request-generation correction proposal for independent review. Existing P1 code must remain development-only until the protected lifecycle correction and automatic-resume failure are reviewed and retested.

**Correction to the preliminary callback diagnosis:** the first origin probe failed the OTT-disabled-path assertion; its unformatted failure line was initially misinterpreted as callback acceptance. The final isolated run passes hostile callback rejection with the exact HTTP 403 / `INVALID_CALLBACK_URL` response, hostile credentialed preflight rejection, preserved original session and disabled OTT HTTP 404. No callback runtime fix was applied. There is no confirmed callback-acceptance defect in the final local setup. P0's Node-Origin observation and all hosted trust checks remain limitations.

## Changed files and why

| Paths | Purpose |
|---|---|
| `convex/schema.ts`, `convex/platform/identity.ts` | Stable platform user table/index, transactional first-login mapping and centralized live identity validation |
| `convex/auth.ts`, `auth.config.ts`, `convex.config.ts`, `http.ts`, `platform/config.ts` | Pinned official integration, private public surface, exact origin configuration and unchanged long-session/short-JWT policy |
| `convex/provision.ts`, `scripts/provision-owner.mjs`, `scripts/setup-local-auth.mjs` | Operator-only library credential provisioning; local utility suppresses sensitive CLI output |
| `convex/platform/sessions.ts` | Scoped pagination and server-only token resolution for library revoke API |
| `convex/_generated/*` | Actual Convex CLI-generated model/API/server files; never manually fabricated |
| `apps/web/src/auth/` | Official client/provider, readiness/retry, private state disposal, sign-in/out/session UI, bounded allowlisted diagnostics |
| `apps/web/src/main.tsx`, `config.d.ts`, Vite config | Shell independent of auth, lazy account UI and typed build-owned public URL configuration |
| `patches/`, lock/workspace/package/typecheck config | Declaration-only compatibility corrections, separate Bun/auth and Vite/tooling type environments, reproducible strict checks |
| `tests/auth/` | Actual browser/local-service scenarios, stale-response regression, real-time resume, production timing/export |
| Boundary/bundle scripts and tests, CI metadata | Narrow host-only generated API/client imports; include required auth runtime in budget; retain all P0 protections |
| ADR 0002, README, this report | Protected-core decisions/proposals, A08 design, reproduction instructions and evidence limits |

No workspaces, instances, apps with persistence, files, R2, agent grants, OAuth provider, MCP endpoints, custom-host bindings, P2 features or production deployment were added. Deltos remained untouched.

## Protected contracts touched

Identity mapping, browser session startup/storage/disposal, live session authorization, private provisioning and session revocation. The implemented transport is a candidate, not an accepted change. Configuration explicitly rejects wildcard/credential-bearing/non-origin entries and non-HTTPS schemes except HTTP localhost; it requires a configured secret of at least 32 characters rather than allowing a library fallback. These enforce the existing exact-origin/explicit-secret policy and do not alter the valid local configuration. The lifecycle failures above block adoption. Session policy is exactly `expiresIn=31_536_000`, `updateAge=86_400`, `freshAge=86_400`, sliding enabled, cookie cache disabled, client session-data cache disabled, access JWT 900 seconds, with Convex's five-second custom-JWT verifier clock-skew tolerance. Credential storage is JavaScript-readable localStorage, not HttpOnly cookies: the official cross-domain jar holds the long `better-auth.session_token` and the adapter's 900-second `better-auth.convex_jwt` cookie. The provider also caches JWTs in memory; the JWT is not memory-only. Client session/profile-data caching remains disabled. Hosted origins still need a real proof.

Explicit logout hides private state before network completion. The official adapter clears local credentials at signout request initialization; failed network signout therefore reports that server revocation is unconfirmed. It does not claim unrelated devices/grants were revoked. Transient startup/renewal errors retain credentials and present retry, never directly force sign-in. React client disposal waits until nested provider cleanup finishes; the initial implementation's premature close error was reproduced and corrected before the final short suite passed.

Session list/revoke derive the live provider user and enforce same-user ownership; tokens never appear in platform API results. The identity helper maps verified subjects to platform IDs. P2 must consistently use this boundary for future workspace/resource ownership. No raw provider session is supplied to app host props.

## Pinned dependencies and compatibility evidence

Auth runtime unchanged: Better Auth **1.6.30**, Convex adapter **0.12.5**, Convex **1.45.0**. React/DOM 19.3.0, Vite 8.2.2, TypeScript 7.0.2, pnpm 11.5.3 and Node runtime 24.18.0 remain pinned. OAuth-provider 1.7.3 remains absent and incompatible; resolving it is P5 work.

Browser imports uncovered declaration errors not exercised by P0's server spike. Three checked-in patched packages correct only declarations: adapter `AuthClient` tuple inference and a regenerated component schema declaration; Better Auth's generic `role` return declaration; Better Fetch 1.3.1's explicit-undefined support on optional option/hook fields. The adapter schema declaration was generated by the actual pinned TypeScript toolchain from unchanged packaged source, not fabricated or hand-edited Convex `_generated` files. Required property/value types remain enforced; `tests/auth/types.ts` rejects missing/non-string passwords, invalid cache modes and plain-string platform identities. Patches must be reviewed and removed when compatible upstream declarations pass these checks.

Final typechecking retains strict mode, library checking and the original `exactOptionalPropertyTypes: true`. A diagnostic run disabling the latter isolated the declaration incompatibility, but that relaxation is **not retained**; the final full typecheck passes with declaration-only corrections. Vite/Bun conflicting ImportMeta globals are separated by typecheck projects. Node declaration support moves to the already-pinned spike's 26.4.0; runtime remains Node 24, and no Node 26 APIs are adopted. No `any` escape hatch, ignored error or `skipLibCheck` was added. ADR 0002 includes the declaration generation command and rationale. All 47 adapter, 257 Better Auth and two Better Fetch runtime JavaScript files were compared byte-for-byte across the patches and are unchanged; the installed component schema declaration exactly matches the pinned compiler's generated output.

`pnpm install --frozen-lockfile --strict-peer-dependencies` passes with the patches. `pnpm audit --audit-level=moderate` reports no known vulnerabilities at this check; it is not a long-term maintenance guarantee. The P0 sharp override is retained.

## Acceptance IDs → commands, observations and limits

| ID | Test / result | Acceptance scope |
|---|---|---|
| A01 | `node tests/auth/p1.mjs`: eight simultaneous official-client token demands per page across two real shared-storage tabs, real provider subscriptions, stable mapping race | Local browser/service scenario passes. Actual PWA/iPhone independent installations remain pending; no grants exist |
| A02 | Same: server completes daily sliding renewal, browser response is dropped before adapter processing, old credential is retained and retry gets the renewed session. Successful token response delayed over 4 seconds also survives | Local pass, stronger than P0's header-jar JWT discard. The separate old-account delayed response fails A07 |
| A03 | `pnpm test:auth:resume`: production-build tab frozen until real 900-second JWT expiry, old JWT must fail on real server, then observe automatic provider token acquisition without reload or imperative token demand | **Blocked locally.** Old-token denial and no-navigation checks passed; no token response or distinct valid token appeared within 30 seconds after thaw. Chromium lifecycle control is not iPhone/PWA proof |
| A04 | Short suite injects HTTP 429, HTTP 503, network timeout/abort during token acquisition and startup, plus a held startup request over 3 seconds; shell stays visible, no false sign-in, credential equality checked, retry restores protected UI | Local real integration with controlled transport faults passes; no actual provider outage or phone result claimed |
| A05 | Short suite obtains positive protected access, revokes A from B, confirms JWT still unexpired, denies A's query/mutation, and confirms B's same stable identity survives. Cross-user revoke targets a live session and is denied while that owner's positive access survives | Device revocation local pass. Agent-grant independence remains P5, not faked by a dummy grant |
| A06 | Short suite checks initial 365-day session/900-second JWT, immediately before/after daily update threshold, old creation timestamps without a hidden idle cutoff, just-before expiry sliding and just-after expiry denial | Real Better Auth/Convex calls with admin-only fixture timestamp changes pass. Production code contains no test clock or bypass |
| A07 | Normal logout, account switch, private region disposal, cross-user session scope, shared-tab logout and failed-signout semantics pass in short suite. `node tests/auth/stale-response.mjs` **fails** the delayed old-account sliding response assertion | **Blocked.** No A07/full-P1 pass. Actual app titles/drafts/snippets do not exist yet; P2/P4 must extend the cleared boundary and recoverable draft behavior |
| A08 | ADR 0002 proposes library reset + optional TOTP behavior and explicitly retains phrase-recovery review requirement | Design written; not independently reviewed or implemented. Carried to P9; real data blocked |
| U01 | Short suite asserts shell visibility under delayed/failed auth. `node tests/auth/performance.mjs` measures real production browser FCP and authenticated account data separately; `tests/browser/shell.spec.ts` tests theme/storage/chunk faults | Local desktop evidence passes. Owner iPhone/network/cache budgets still pending |
| Transport | `node tests/auth/origins.mjs`: registered authenticated client succeeds; hostile browser preflight blocks credentialed signout and preserves session; hostile callback returns HTTP 403 / `INVALID_CALLBACK_URL`; OTT returns 404 | Local browser pass. Hosted adoption remains pending and P0 Node-origin observation is retained |
| Redaction | Production timing/export test parses the actual downloaded export and requires only version, known reason codes and numeric timings | Pass for implemented diagnostics; no resource/editor/file/agent diagnostics exist yet |

## Real integrations, mocks and device evidence

Actual anonymous root Convex backend on loopback 3214/3215, actual Better Auth component, actual CLI generation/push, official browser client/provider, real browser localStorage reloads and shared-context tabs. Fixtures use random credentials held in memory; privileged setup and session timestamps use local admin CLI calls with output suppressed. No fake auth/database implementation or identity injection is deployed. Provisioning is internal operator functionality, not a production test bypass.

The short suite uses Vite development serving. Production timing and the clean real-expiry run use the built static assets served by Vite preview on the registered localhost:5173 origin. Production shell tests also use a separate local preview on 4173, whose auth origin is intentionally unregistered: those tests prove shell behavior, not successful auth at that origin. Chromium 153.0.8010.12 / Playwright 1.63.0 on Linux headless. Six P0 shell tests pass in desktop and Pixel 7 viewport emulation.

Mock/fault boundaries: Playwright routes deliberately fulfill 429/503, abort network requests, hold responses or discard a response **after real server success**. Session-age tests modify disposable Better Auth component rows using deployment-admin access; server code and real hashing/JWT/session implementations are unchanged. P0 shell tests simulate unavailable localStorage and a failed app chunk. Import tests use source fixtures. These controlled faults are not real service outages. No browser trace, raw storage export, secret-bearing URL, password, session token, recovery material or private content is logged/committed.

No Safari/WebKit, real iPhone, installed PWA, actual Cloudflare serving, hosted Convex HTTPS origins, DNS/custom hostname, R2, real MCP client, agent grant or recovery/TOTP check was performed. Hosted CI itself was not run. Early development resume attempts were cancelled while refining the observation test and while source changed. The first clean production run checked at encoded JWT expiry +2 seconds and did not throw; its harness did not distinguish a null denial from authorized data, so it stopped before resume without a valid negative result. Investigation of the official Convex verifier found its five-second clock-skew allowance, so the corrected final test waits until expiry +6 seconds and accepts the query's documented null denial as well as an expired-auth exception. An intervening rerun was cancelled before expiry to apply that timing correction. No runtime policy was changed. Those incomplete attempts are not resume acceptance evidence; only the final clean production-build run is eligible below.

## Performance

Production bundle: **104,296 bytes gzip** for shell + immediately requested required auth runtime (101.85 KiB), against 204,800 bytes. Login/account/app entries remain separate lazy chunks; no editor/voice/Deck/PDF/inactive app runtime enters this closure. Static shell-only cost is 70,692 bytes. The budget script now counts required auth even though it is asynchronously loaded; it does not exploit lazy loading to omit auth cost.

Production timing conditions: six fresh Chromium contexts with persisted fixture credential copied **only in memory** (cold HTTP cache), each followed by one reload in the same context (warm cache). Linux headless, loopback network, no CPU/network throttling. Browser FCP is measured from PerformancePaintTiming; authenticated-data marker is emitted only after a positive protected identity query. The separate bootstrap rAF marker is not mislabeled as paint.

| Production measurement | Median | p95 (nearest-rank, n=6) |
|---|---:|---:|
| Cold FCP | 58 ms | 72 ms |
| Cold authenticated data | 550.5 ms | 921.2 ms |
| Warm FCP | 26 ms | 36 ms |
| Warm authenticated data | 476.55 ms | 481.7 ms |

Cold FCP samples: 72, 60, 56, 60, 56, 56 ms. Warm: 20, 32, 36, 20, 20, 32 ms. Small local samples are not owner-device budget acceptance. First sign-in/password entry latency is excluded; these are persisted-session launches. No collaboration/save/file latency exists in P1. The short suite also reports dev-server timings; those are not substituted for these production figures.

## Checks and carried P0 limitations

Locally passed: the final strict typecheck (SDK/tooling, web including auth type regressions, and backend); import lint; six boundary tests and three pure auth-configuration tests; production build and auth-inclusive bundle gate; `pnpm format:check`; `pnpm test:browser` (six); `pnpm hosting:check` (Wrangler dry run only); `pnpm --filter @palladian/auth-spike typecheck`; strict frozen dependency install; advisory audit; `git diff --check`; the 11-scenario short real-auth suite; and production timing/export. The A07 stale-response regression still fails; the corrected A03 automatic-resume regression fails and is not a pass. The final origin probe passes. Static checks do not replace the separately documented actual-auth tests. The final strict typecheck, lint, nine tests and formatting checks were rerun successfully during the final freeze; served assets were not rebuilt.

All P0 evidence limitations are carried: real iPhone/Safari/PWA install/background/storage behavior; hosted Cloudflare/Convex CORS/CSRF and hostname trust; social/OTT/OAuth callbacks before enabling them; final owner-device median/p95 budgets; recovery/phrase/TOTP; independent agent-grant lifecycles; P2 authorization/data, R2/files, collaboration, schedules, input/voice/Deck, exports/restore, custom domains, release operations and real MCP-client compatibility. Some local P1 auth evidence is now stronger, but none closes those external/device/downstream items. The prior P0 service probes were not rerun as though they were new evidence; the P0 spike remains intact and its typecheck passed.

MCP remains SDK v2 / protocol 2026-07-28 only in the plan; no protocol package or legacy fallback was installed. The incompatible OAuth-provider dependency remains P5. No old migration/cutover plan was executed.

## Spec deviations and review decisions needed

Review the A07 protected-boundary correction proposal and A03 automatic-resume investigation in ADR 0002 before further lifecycle implementation. No session-policy relaxation is proposed. Review the declaration-only patches and their actual-toolchain generation evidence while retaining the original checks. A08 phrase recovery remains unresolved and must not be replaced silently with email or operator recovery. Diagnose the failed A03 automatic recovery with safe provider/connection timing evidence, then rerun the existing distinct-token and protected-data assertions before claiming recovery. Do not introduce a custom refresh lifecycle to make that probe green. No downstream phase may use the currently failing lifecycle as an accepted foundation.

## Reproduce and revert

Follow README's P1 setup with a fresh anonymous local deployment and fixture secret; do not use production or cloud overrides. Public auth configuration uses exactly localhost:5173. `pnpm dev` is needed for the short/direct-module probes; static Vite preview at the same registered port is needed for production timing and real-time expiry checks. Do not run both on that port. Run the short suite, origin probe and stale-response regression individually; the stale-response file fails. Run the long resume probe separately; its corrected full-window observation also fails. The real-expiry check takes roughly 16 minutes and must not be interrupted by source rebuilds/reloads. Fixtures remain in ignored local state; never import/adopt that state as real data.

Revert this report commit, then `970d94145f3b7b3a382fb75c0eee1c7bd9b03f8b` and `f61a6a21d0083cf3c7f6a92ea7ba351921d16b33` in that order if needed, preserving the owner's specification edits. No external infrastructure rollback is necessary. Stop local processes before any separately authorized disposal of fixture state; do not remove shared Convex state or the read-only Deltos reference.

## Next checkpoint

Stop for the owner's independent P1 protected-core review. **P1 is not accepted, and P2 is not permitted on these failures.** The next implementation work should be a specifically reviewed P1 correction to the lifecycle/transport findings, followed by rerunning the same assertions and independent re-review. No production deployment is authorized.

## Final validation addendum

The corrected `pnpm test:auth:resume` completed at 19:52:58 UTC against unchanged production assets. Its safe diagnostic result was `{expiredJwtDenied:true,resumedWithoutNavigation:true,tokenResponseObserved:false,distinctUnexpiredTokenObserved:false}`. The original 900-second JWT was denied after encoded expiry +6 seconds, beyond the five-second verifier tolerance. After thaw, the observer waited the full 30 seconds for a token distinct from the original with a future expiry. None was observed. **A03 fails locally.** The positive post-resume protected-data assertion was not reached. A real iPhone/PWA remains pending regardless.

The preceding probe could stop on any observed response, including a late initial response; that preliminary failure was ambiguous. The final probe corrects that observer without changing runtime behavior or weakening the success assertion. The final failure establishes the local gate result, not its root cause. Investigate the existing official provider's renewal scheduling/connection lifecycle and this integration, with redacted timing/status evidence; any protected lifecycle correction requires review before implementation. Do not introduce imperative token demands into this acceptance probe.

### Historical 2026-09-09 closeout (superseded by correction evidence below)

The final freeze used unchanged production frontend assets. Declaration-only corrections and exact-origin/explicit-secret checks were complete before it started; all library runtime bytes and the valid localhost/secret/session policy remained unchanged. Actual-host/phone evidence is not implied. The final short suite also strengthens public-signup rejection to a previously nonexistent address with the exact disabled-signup code, checks both persisted credential lifetimes, and targets a live other-owner session in the negative revoke test.

After the final freeze, the strengthened 11-scenario short suite passed in full. The production build and 104,296-byte auth-inclusive bundle gate passed again with unchanged asset hashes. Owned local frontend/backend processes were stopped after validation; ignored disposable fixture state was retained.

## Roadmap correction session — 2026-09-10 (accepted locally)

The owner assigned ongoing backend-first roadmap execution with subagents and independent adversarial review. Base remains `b315159`; independent P1 review is now recorded separately in `P1-review.md`. P1 is not accepted while correction work and real regression evidence are incomplete.

The initial browser rerun in this session selected port 5173, which was already occupied by an unrelated project's Vite process. Its disposable fixture sign-in failed and provides no Palladian acceptance evidence. No real owner credential was used. That process was left untouched. Started the existing anonymous Convex deployment on 3214/3215, selected free localhost port 5183 for Palladian, and changed only that anonymous deployment's exact `SITE_URL` accordingly; the secret and session/origin policy were preserved.

`scripts/local-auth-origin.mjs` validates an explicit localhost test-origin override; setup and browser probes share it. `tests/auth/environment.mjs` checks the frontend's exact Palladian title before submitting even fixture credentials. This prevents ordinary wrong-target mistakes; it is not authentication of an untrusted local service. The default remains localhost:5173. The Account UI now states that the development account is disposable and recovery unavailable, correcting the misleading previous operator-reset claim without adding a reset path.

Subsequent correction evidence and the actual package runtime changes will be recorded here after completion. Prior declaration-only patch descriptions above describe the historical baseline, not prospective runtime corrections.

Fresh baseline on the correct frontend, before runtime correction: `PALLADIAN_TEST_FRONTEND_ORIGIN=http://localhost:5183 node tests/auth/p1.mjs` passed all 11 actual Chromium/local-service scenarios; `origins.mjs` passed authenticated registered-origin access, hostile browser preflight with session survival, disabled OTT and exact hostile callback rejection. The hostile-origin fixture now binds an ephemeral loopback port because 5176 was also occupied; its origin remains distinct and untrusted. Independent review accepted these harness changes. The original `stale-response.mjs` again failed the unchanged substantive assertion that delayed A renewal cannot replace B. Controlled network faults are test injections; auth/session/JWT/Convex operations are actual services. No iPhone, hosted service, R2 or production evidence is claimed.

The independent A03 investigation (`P1-resume-investigation.md`) and review supersede the earlier claim of a physically frozen Chromium tab: the old Playwright setup kept the page visible and its timers running. The replacement harness proves actual hidden/freeze/resume events and timer suspension, discriminates auth denial from network errors, and counts only token requests dispatched after thaw. Actual startup inspection observed two identical JWT responses, reaching Convex's `notRefetching` branch. The independently reviewed `initialAuthTokenReuse: true` option now schedules the official renewal lifecycle from the server-confirmed initial JWT; a fresh local startup observed one JWT response and working private account. This is an existing experimental Convex option, not a custom token timer. Full real-expiry proof remains pending until the immutable production run completes.

Independent review also found stale application callbacks beyond the package boundary. `Runtime.tsx` now binds startup/signout completions and descendant callbacks to the current connection generation; old success or failure cannot reset/hide/sign out a newer connection. Global storage/online handlers still initiate current resets. `Account.tsx` ignores a completed current-session revocation after that Account has unmounted, preventing its old callback from signing out a later account. These restore the existing A07 contract; independent browser regressions and final code acceptance remain pending.

### Corrected candidate evidence before the full expiry run

Runtime patch design and removal conditions are in ADR 0003. Package versions and session lifetimes are unchanged. Source/emitted adapter and provider fixes, Better Fetch cancellation checkpoints, and exact superseded-session cancellation handling are now runtime patches, with strict source checks included in `pnpm check`. Web Locks cover shared storage transitions only; unavailable locks retain credentials and fail closed. The final implementation avoids `AbortSignal.any` to retain the documented Safari 16.4 browser baseline.

| Check | Latest result and scope |
| --- | --- |
| `pnpm check` | Pass: strict application/backend types and patched runtime TS sources, import boundaries, 20 local tests (11 use mock transport/storage), production build and bundle budget |
| `pnpm format:check`; `git diff --check` | Pass; patch artifacts preserve upstream context whitespace through a narrowly scoped `.gitattributes` rule |
| Frozen strict dependency install | Pass during correction; final patch installation/source validation also passed through the pinned toolchain |
| `tests/auth/p1.mjs` at localhost:5183 | All 11 actual Chromium/local-service scenarios passed with the corrected runtime; controlled network faults remain injections |
| `tests/auth/origins.mjs` | Registered authenticated access, hostile preflight/session survival, disabled OTT and exact invalid callback passed locally; hosted proof pending |
| `tests/auth/stale-response.mjs` | Parent and independent reviewer each passed original delayed A→B response and actual separate-tab A→B response with B UI/session/positive backend identity in both tabs |
| `tests/auth/stale-ui.mjs` | Parent and reviewer each passed delayed real signout and delayed continuation after real self-revocation; current B UI/access survive and A is denied. Revoke continuation delay is test-only browser module instrumentation after the actual server operation |
| `tests/auth/lifecycle-preflight.mjs` | Independent actual Chromium freeze/resume/timer-suppression proof passed, including browser-profile cleanup |
| `pnpm test:browser` | Six production shell tests passed on desktop and mobile-emulated Chromium during correction; emulation is not an iPhone |
| `pnpm hosting:check` | Workers Static Assets dry run passed; no publication |

The final local production assets contain 105,057 bytes of required shell/auth JavaScript gzip (budget 204,800). The 10-file immutable asset digest for the independent full-expiry run is SHA-256 `2acde5215469cb1d13d33cc6077b61070ac68e67750e383f38bd6c6d19a941ac`, computed over sorted relative paths, a NUL separator per path, and file bytes. Production preview uses localhost:5183 and the same anonymous 3214/3215 backend. No rebuild or runtime edit is permitted during that run. Outcome remains pending until recorded by the independent reviewer.

Correction implementation commit: `14c0134`, following planning-only `a269ecb`, with original implementation/report baseline `b315159`. The owner's existing specification/AGENTS/handoff edits were preserved and not included in these commits.

While the independent expiry run held its own page suspended, `PALLADIAN_TEST_FRONTEND_ORIGIN=http://localhost:5183 node tests/auth/performance.mjs` passed against the same immutable production assets. Conditions: Chromium 153.0.8010.12, Linux headless, loopback, no network throttling, disposable persisted credentials transferred in memory, six cold browser contexts and six warm reloads. Cold FCP median/p95: 64/68 ms; cold authenticated-data median/p95: 513.8/536.3 ms. Warm FCP median/p95: 32/40 ms; warm authenticated-data median/p95: 447.5/553.8 ms. Allowlisted diagnostic export passed. These are local desktop measurements, not hosted-network or iPhone budget compliance.

`pnpm audit --audit-level=moderate` on 2026-09-10 reported no known vulnerabilities for the pinned dependency graph. This is a point-in-time advisory result, not a substitute for source or runtime review.

### Independent full-duration A03 result — 2026-09-10

The independent reviewer ran `PALLADIAN_TEST_FRONTEND_ORIGIN=http://localhost:5183 node tests/auth/resume.mjs` against correction `14c0134`. It exited 0 after the real 900-second JWT lifetime plus verifier tolerance. Actual hidden/freeze/resume observations and deferred timer execution passed; the old JWT was denied by the real server; the official client obtained a distinct, unexpired token after thaw without navigation or a direct token demand; the original positive platform identity and restored private UI assertions passed. Safe result: `expiredJwtDenied=true`, `resumedWithoutNavigation=true`, `tokenResponseObserved=true`, `distinctUnexpiredTokenObserved=true`.

The reviewer verified all 10 production files unchanged before/after the run. Their independently serialized path/hash manifest digest is `0d8effde292268212aa3ee2637237334ac372b56f1c02184a542fa0ece78c66f`; the differently serialized parent aggregate above identifies the same asset set. This closes the corrected local desktop A03 gate. It does not close hosted or physical iPhone/PWA behavior. Final acceptance is recorded by the reviewer in `P1-review.md`; no implementation report self-approval is implied.
