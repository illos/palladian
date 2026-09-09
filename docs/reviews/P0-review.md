# P0 independent review

Date: 2026-09-09. Decision: **changes required**. Two medium-severity P0 defects require correction and independent re-review before P0 acceptance. No critical/high-severity implemented auth defect was demonstrated. P1 has not been implemented or authorized by this review.

Reviewed baseline `f691c1d`, implementation `f3ce322295074839ade6cbf2b661090e3197cb8a`, and implementation-report commit `c34bdd2`. Read AGENTS.md, the platform specification, execution plan, implementation report, ADR 0001, implementation source/diff, test assertions, and relevant installed library source. The separately modified MCP v2 specification/handoff files in the working tree govern this review and were preserved. Reviewer did not implement P0. Applied the Convex reviewer skill and local-deployment guard.

## Required changes, ranked by severity

### 1. Medium — client/server import enforcement permits server package entry points

Evidence: `scripts/check-boundaries.mjs:35–44`; coverage in `tests/boundaries.test.mjs:4–12`. Requirement: P0 source import boundaries; execution-plan repository-layout contract; specification §3 client/server separation.

The guard rejects `better-auth/minimal` and `node:fs`, but accepts the server factory from bare `better-auth`, and Node builtins such as bare `fs`. These are ordinary legal import spellings, not an adversarial runtime loader. Consequently the required boundary check reports no violation when an app imports server runtime code. Existing production imports are clean; this finding does not claim credentials currently ship in the frontend.

Reproduced from repository root:

```sh
node --input-type=module <<'JS'
import { violations } from './scripts/check-boundaries.mjs';
for (const source of [
  'import { betterAuth } from "better-auth";',
  'import { readFileSync } from "fs";',
]) console.log(source, violations('apps/web/src/apps/notes/entry.tsx', source));
JS
```

Observed: both return `[]`. The source-string tests pass because their rejected cases cover only a small subset of server import spellings.

Required fix: classify bare and `node:` builtin specifiers with the platform builtin list and distinguish explicitly client-safe Better Auth entry points from server entry points. Add regression assertions covering these imports, re-exports, and fixed dynamic imports, plus allowed client-safe imports. Keep future host-owned auth client imports possible through a narrow rule; do not remove the boundary wholesale. This remains a trusted-code mistake-prevention tool, not a sandbox.

### 2. Medium — app definition loses its instance type at the lazy UI boundary

Evidence: `packages/app-sdk/src/index.ts:28–30` and `:42`, compared with generic `AppHostProps` at `:22–25`. Requirement: P0 typed definition/instance interfaces and specification §4 typed app-host contract.

`AppDefinition<D>` preserves `D` for metadata but returns nongeneric `AppUIModule`, whose `Root` must accept every definition's instance. A correctly specialized Notes component accepting `AppHostProps<"notes">` therefore fails to register under strict TypeScript. The previews hide this because both currently accept the broad default `AppHostProps` and ignore it. This is a defect in the shipped SDK seam, not a request to implement Notes or instances now.

Reproduction: temporarily place the following source in a root-level `.ts` file:

```ts
import type { AppDefinition, AppHostProps } from './packages/app-sdk/src/index';
const Root = (_props: AppHostProps<'notes'>) => null;
const loadUI: AppDefinition<'notes'>['loadUI'] = async () => ({
  Root, Preview: () => null,
});
void loadUI;
```

Run `pnpm exec tsc --ignoreConfig --strict --noEmit --moduleResolution bundler --module esnext --target es2023 --types node <temporary-file.ts>`. Observed compiler exit 1, TS2322: the Notes Root is not assignable to `ComponentType<AppHostProps<DefinitionId>>`, because a Recipes instance is not a Notes instance. The review created and removed its temporary file. An initial compiler-API attempt could not run because the installed TypeScript package did not expose `ts.sys`; the CLI reproduction above succeeded and is the evidence for this finding.

Required fix: thread `D` through `AppUIModule<D>` and `AppDefinition<D>.loadUI`, and specialize the two Root exports. Add compile-time coverage proving a matching definition/Root compiles and mismatched instances/Roots reject, without casts, broad types, or suppressions. Preserve the separate instance-free Preview seam.

## Architecture and compatibility assessment

The themed static shell, isolated fixture backend, logical branded IDs, private source packages, and two lazy empty entries fit P0. The Preview seam honestly avoids fabricated instances or service implementations. No Deltos source was imported, no authoritative local database was added, and no runtime code execution or namespace sandbox claim was found. The actual eager graph contains neither app runtime; gzip measurement is 70,202 bytes including theme bootstrap. Required auth/client code is absent, so the final 200 KiB budget remains unproved.

The actual spike's only authored public query, `spikes/auth/convex/auth.ts:27–31`, validates arguments/return value and calls `authComponent.getAuthUser(ctx)` before returning true. The installed adapter's `src/client/create-client.ts:144–188` obtains verified identity, queries a nonexpired session by JWT session ID, then resolves the provider user. This is a live revocation check, not merely JWT validity. Real positive access precedes the exact `ConvexError('Unauthenticated')` negative assertion in `spikes/auth/probe.mjs:47–54`, so an all-denied backend cannot pass it. No platform-owned records or resource ownership checks exist yet; those are P1/P2 work. Component signup is confined to the documented loopback fixture, not the web deployment.

The installed adapter peer range `better-auth >=1.6.11 <1.7.0` accepts 1.6.30, and strict frozen installation passed. The current [official React guide](https://labs.convex.dev/better-auth/framework-guides/react) continues to document the 1.6 family and cross-domain integration. The [supported-plugin list](https://labs.convex.dev/better-auth/supported-plugins) includes two-factor support, which is not proof of recovery or OAuth-provider compatibility. Registry inspection independently confirmed OAuth-provider 1.7.3 requires Better Auth/core ^1.7.3. Keep that recorded P5b blocker; do not force peers or substitute the stack. The clean audit is a point-in-time advisory result, not proof of future maintenance.

ADR `:42–58` correctly distinguishes JavaScript-readable cross-domain credentials, provider subjects, stable platform IDs, long sessions, short JWTs, and live revocation. Installed `cross-domain/client.ts` uses localStorage and `credentials: omit`; installed `routes/session.mjs:205–237` contains sliding expiry renewal. The Node probe proves configured initial durations but does not prove daily renewal, expiry boundaries, or official browser persistence. Provider source also handles token acquisition failure separately from storage; its end-to-end behavior must still be tested before adoption. Do not copy the integration's experimental redirecting AuthBoundary into a global shell gate.

The custom-header signout from an untrusted Node Origin again returned 200. Installed `origin-check.mjs` checks ordinary Cookie-bearing requests, while the adapter translates its custom header in hooks. The separate real Chromium CORS probe blocked the unregistered browser origin. These observations do not demonstrate a hostile browser can obtain another origin's credential or cause a credentialed action. They also do not establish complete CSRF/callback safety. Cross-domain OAuth's `skipStateCookieCheck: true` and one-time-token redirect behavior require separate review before enabling those paths. **Production/browser transport adoption remains blocked by missing evidence**, as the ADR already states; no custom proxy or protected-contract relaxation is approved here.

The current owner MCP policy is preserved. Independently packed `@modelcontextprotocol/server@2.0.0` into disposable temporary storage and inspected published `.d.mts`/`.d.cts`: HTTP legacy defaults to stateless and accepts `legacy: 'reject'`; stdio also accepts `'reject'`; server options expose `supportedProtocolVersions`. ADR `:78` records the necessary rejection and restricted protocol configuration. No MCP package is installed in the app, and no endpoint/client interoperability is claimed. M08–M10, ChatGPT/Codex/Claude Code opt-ins and observed protocol versions remain P5 evidence; missing access/documentation does not authorize fallback.

## Independently reproduced checks

| Command/check | Result | Evidence scope |
|---|---|---|
| `pnpm install --frozen-lockfile --strict-peer-dependencies`; `pnpm list --depth 0` | Pass; expected pins | Actual installed workspace dependencies |
| `pnpm check` | Pass; strict types, lint, 3 tests, build, graph/budget | Actual P0 source/build; boundary coverage gaps above |
| `pnpm --filter @palladian/auth-spike typecheck` | Pass | Actual generated types and library declarations |
| `pnpm format:check` | Pass | Script's configured source scope |
| `pnpm hosting:check` | Pass | Wrangler dry run only; no hosted serving |
| `pnpm audit --audit-level=moderate` | No known vulnerabilities | Current registry advisory check |
| `pnpm test:browser` | 6 passed | Actual production build in desktop and Pixel 7-emulated Chromium |
| Local `convex dev --typecheck disable`, then `node probe.mjs` | 15 assertions passed; hostile-origin observation reproduced | Actual anonymous local Convex + Better Auth; Node HTTP/Convex clients |
| `node browser-cors.mjs` | 2 passed | Actual Chromium, two loopback frontend origins, actual auth HTTP endpoint; empty credential header |
| Negative import/type reproductions above | Defects reproduced | Existing guard and actual pinned TypeScript compiler |
| `git diff --check` | Pass | Working-tree whitespace check |

Before starting Convex, verified anonymous target, exact loopback URLs/ports, and absence of deployment overrides; announced the classification. Used existing isolated fixture secret without rotation or disclosure. Stopped the watcher with Ctrl-C after probes. Generated tracked files remained unchanged. No cloud deployment, DNS, R2, production, Deltos, or real-data writes occurred. Temporary compiler/MCP files were removed. Hosted CI was not run by the reviewer.

Browser resilience tests use request abortion and unavailable-storage injection; boundary tests use source strings. Auth used no mocks. Chromium mobile emulation is not Safari or a real iPhone. Browser CORS readability is not authenticated browser session lifecycle evidence. The discarded successful JWT response in `probe.mjs:48` is not a dropped sliding-renewal response: the jar has already processed headers.

## Evidence carried forward and checkpoint

P0-required build/type/peer/lazy evidence is demonstrated, subject to fixing the two P0 contract/tooling findings. The following are deliberately pending later acceptance, rather than mislabeled failures of this minimal shell:

- A01/A02/A05/A06 have partial local-service evidence only. Official-client reload and cross-tab/PWA concurrency, dropped renewal responses, sliding/expiry/inactivity boundaries, and independence from real agent grants remain pending.
- A03/A04/A07/A08: phone resume, fault-injected timeout/429/5xx, logout/account-switch private-cache clearing, private provisioning and identity mapping, recovery/TOTP remain pending. P1 must retain the phrase-recovery review requirement.
- U01/O01 remain partial: shell availability is demonstrated; authenticated-data timing, actual phone/network/cache conditions, repetitions, median/p95, and final auth-inclusive bundle size are unmeasured.
- Actual hosted Cloudflare/Convex CORS/CSRF, hostile callbacks, custom-host trust, Safari/WebKit, real iPhone/install behavior, R2 and downstream application/MCP/operational acceptance remain unperformed in their assigned phases.

Required next work is a bounded P0 correction for findings 1 and 2 with regression evidence, then independent review of that revision. This review does not fix code, approve the auth transport, begin P1, or authorize deployment. Owner MCP specification changes remain untouched.

## Correction review — 2026-09-09

**Current P0 decision: accepted.** Independently reviewed correction commit `0912774` against review baseline `55bf2fd`, including the appended implementation evidence. Both medium findings above are resolved. This decision supersedes the original P0 changes-required decision while preserving its evidence history. No new P0-blocking defect was found in the bounded correction.

**Finding 1 closed:** `scripts/check-boundaries.mjs` now uses `isBuiltin` for bare/prefixed Node imports, rejects unrecognized `node:` imports, and denies Better Auth package entry points except five explicit client exports inside the host's `src/auth/` boundary. Re-ran the original bare `better-auth` and `fs` reproductions; both now produce violations. Inspected the expanded tests: they exercise static imports, re-exports, and fixed dynamic imports across the builtin list and server auth entries, and assert both allowed host-client imports and rejected app/shared/outside-host imports. Checked installed package export maps: all five allowed paths resolve to actual client/React exports. The guard remains a trusted-code import discipline, not a sandbox or authorization mechanism.

**Finding 2 closed:** `AppUIModule<D>` now carries the same definition parameter through its Root and `AppDefinition<D>.loadUI`; Notes and Recipes Roots accept their specific instance types. Re-ran the original Notes-registration compiler reproduction using the same strict CLI options: exit 0, no diagnostics. Inspected `tests/types/app-sdk.ts`: positive loaders use actual app exports; negative assertions check mismatched instances, Roots, and loaders with `AssertFalse`, not ignored compiler errors or casts. Confirmed `tsc --listFilesOnly` includes that file. The Preview export remains instance-free. The production registry still compiles, so heterogeneous lazy registration has not been broken by the specialization.

Independently reproduced for this correction:

| Check | Result |
|---|---|
| `pnpm check` | Pass: strict typecheck including type regressions, lint, all 5 boundary tests, production build, lazy graph and budget |
| `pnpm format:check` | Pass |
| `pnpm test:browser` | All 6 passed in desktop/Pixel 7-emulated Chromium |
| Original finding 1 import snippets | Both now rejected |
| Original finding 2 strict compiler snippet | Now compiles successfully; temporary source removed |
| `pnpm exec tsc --listFilesOnly` | New SDK type-test file included |
| `git diff --check` | Pass |

The eager gzip total remains 70,202 bytes and emitted app/shell hashes match the initial review. No dependencies, backend auth runtime, hosting configuration, or protected lifecycle behavior changed. The actual Convex/Better Auth and CORS service probes were **not rerun** for this correction; the original independent local-service evidence remains applicable with its original limits. Dependency installation/audit and hosting dry-run evidence are also carried from the initial review, not represented as new runs. No implementation file was changed during re-review, no commit was made, and the owner's pending MCP specification changes were preserved.

**Acceptance scope remains P0 only.** The architecture and compatibility investigation are sufficient for this phase's checkpoint; production/browser auth transport adoption is still blocked by missing hosted/browser lifecycle evidence. A01–A08 limitations, real iPhone/Safari/PWA checks, recovery/TOTP, hosted CORS/CSRF and callbacks, final auth-inclusive bundle/performance evidence, and real MCP-client checks remain exactly as carried above. No auth proxy, weaker session/origin policy, production deployment, or P1 implementation is approved by this decision. P1 requires a new phase assignment and its own protected-core review.
