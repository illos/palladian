# Dedicated hosted development environment

Prepared 2026-09-10. Dedicated development code and frontend are published, and the corrected nine-group hosted auth smoke passes. Hosted real-expiry verification remains pending. The current publication is an auth shell; the usable Notes/Recipes prototype still requires P2–P4.

## Authorized resource setup — 2026-09-10

After the owner explicitly authorized hosted development and the parent authorized this bounded resource setup, a fresh metadata check confirmed the proposed reference did not exist. The isolated detached checkout `/srv/presidium/projects/palladian/hosted-dev` was created at correction commit `14c01341de205f5014c50156261d0415c72b0793`; only explicit owner instruction and hosting-plan files were copied from the main tree. `pnpm install --frozen-lockfile --strict-peer-dependencies` completed, and the installed auth patch source check passed. No `.env.local`, credentials, local backend state, or object data was copied.

The new cloud deployment was then created using the exact reviewed command below, without `--select` or `--default`. Live metadata readback confirms:

| Field | Actual value |
| --- | --- |
| Team/project | `jim-pringle` / `palladian` |
| Reference | `dev/hosted-pilot` |
| Deployment | `necessary-lynx-217` |
| Type/default | `dev` / `false` |
| Region | `aws-us-east-1` |
| Canonical data URL | `https://necessary-lynx-217.convex.cloud` |
| Canonical auth URL | `https://necessary-lynx-217.convex.site` |
| Planned frontend | `https://palladian-development.rdxx.workers.dev` |

The canonical auth URL was independently obtained through the managed `CONVEX_SITE_URL` variable. `SITE_URL` now equals the planned exact HTTPS frontend origin. A fresh 48-byte random `BETTER_AUTH_SECRET` was configured through a restrictive temporary file, verified without printing its value, and the temporary file was deleted. No paid-plan upgrade was requested by provisioning. The isolated `.env.local` contains only the explicit `dev:necessary-lynx-217` target and public frontend build URLs. Additional non-secret identity metadata is recorded in `.wrangler/palladian-development/identity.json` in the isolated checkout.

At the end of resource preparation, no Convex application code or Worker had been published, and no hosted auth fixture or R2 bucket had been created. Publication followed the independent local P1 acceptance signal as recorded below. The main tree's running anonymous backend, production preview, source, and environment were not modified by this setup.

## Development publication after independent local acceptance

The parent subsequently supplied independent local P1 acceptance at `351cac3`, including the complete real-expiry test against immutable runtime `14c0134`, and authorized publication of that runtime to the dedicated development environment. A fresh control-plane check reconfirmed `necessary-lynx-217` as type `dev`, reference `dev/hosted-pilot`, nondefault. Official `convex dev --once --typecheck enable --tail-logs disable --env-file .env.local` succeeded from the isolated checkout. Generated/runtime files remained unchanged from `14c0134`.

Full strict typechecking, the explicit hosted-URL production build, and the separate Wrangler configuration dry run passed. The build contains only the intended configured backend URLs. A naive URL scan also found the official Convex client's inert validation-error example `happy-otter-123.convex.cloud`; its exact diagnostic string was traced to installed `convex/src/react/client.ts`, not treated as a configured endpoint.

The new Worker `palladian-development` was published in the uniquely matched Cloudflare account after reconfirming its name was unused and subdomain was `rdxx`. Actual URL: `https://palladian-development.rdxx.workers.dev`. Version: `abe16bb8-c0c3-45e9-a3f9-62ca0e89d142`. Aggregate build digest (sorted relative path plus bytes, including build manifest): `3e938be94b5fa8c10ed03e5afc24d4d0402b4a3a5ee157dcf93b3e3944b57060`. All nine served static files were fetched over the actual HTTPS origin and matched the reviewed local build bytes. The tenth local build file is the internal Vite manifest. No production deployment, DNS change, R2 resource, or application runtime change occurred.

The first hosted smoke runs passed target agreement, disabled signup, actual sign-in/reload/shared-tab identity, injected 429/503/network recovery with retained credentials, independent device revocation with an unexpired JWT, and cross-account revoke denial. They then failed the strict hostile-origin session-preservation assertion. Bounded investigation found the hostile page's Playwright route interception remained active: pinned Playwright's `coreBundle.js` automatically fulfills intercepted preflights with the caller's allowed origin. That test bypassed the browser CORS barrier, so the synthetic request could revoke the supplied fixture credential even though the final response was unreadable.

Controls with interception removed after synthetic-page navigation, and separately with an actual `https://example.com` page using no interception, both observed the hosted endpoint's real HTTP 204 preflight without an allowed origin, rejected browser fetch, and preserved the positive fixture identity. The fixture correction preserves the original session-survival assertion and removes only the demonstrated preflight simulation. This is not a server runtime fix or a claim that CORS replaces authentication; the existing Node/custom-header limitation remains recorded. The corrected full smoke result follows; hosted real-expiry evidence remains pending.

The independent reviewer approved that bounded fixture correction, and the corrected full `node tests/auth/hosted.mjs --target jim-pringle:palladian:dev/hosted-pilot` run subsequently passed all nine scenario groups with exit 0. This includes positive hosted sign-in/reload/shared-tab identity, deliberately injected temporary errors and recovery, actual server revocation before JWT expiry, cross-account denial, actual browser hostile-origin blocking with original session preserved, callback HTTP 403/`INVALID_CALLBACK_URL`, OTT HTTP 404, and explicit UI logout with server revocation. Only the temporary-error scenarios deliberately replaced auth responses; positive flows, protected queries/actions, and final hostile-origin auth traffic used actual hosted services. The browser's high-level Playwright preflight request event was not exposed in the full run; actual passive CDP preflight response evidence was captured separately in both successful controls. The runtime and published asset version did not change during these runs. Hosted real-expiry, real iPhone/PWA, and remaining pilot phases are still pending; this publication is an auth shell, not yet the usable Notes/Recipes prototype.

## Concrete target

| Service | Proposed target | Discovery evidence |
| --- | --- | --- |
| Convex | Team `jim-pringle`, project `palladian`, new reference `dev/hosted-pilot`, type `dev` | One accessible team; project already exists; proposed reference returned HTTP 404 |
| Region | `aws-us-east-1` | Current team default; EU west is also available |
| Frontend | `https://palladian-development.rdxx.workers.dev` | One accessible Cloudflare account; workers.dev subdomain `rdxx`; no existing Palladian Worker |
| Bytes, P3 only | New private bucket `palladian-development-files` in the same account | R2 listing available; no existing Palladian bucket |

The existing Convex default development deployment `rightful-marten-995` / `dev/jim-pringle` is outside this plan. Its application data and environment values were not inspected. The new named development deployment keeps this pilot separate from that deployment, the anonymous loopback backend, and Deltos. Do not select the new deployment as the project's default, change an existing deployment's role, or provision a production deployment.

The account/team selection is unambiguous at this discovery. Recheck immediately before provisioning; if more accounts appear, select the previously identified account explicitly rather than relying on Wrangler's interactive default. Record the full account ID only in the operator environment when needed; no cloud access token belongs in source or build assets.

## Meaning of private

The proposed workers.dev shell and static JavaScript are reachable on the internet. Better Auth's existing private owner provisioning, disabled public registration, live-session checks, and subsequent resource authorization protect accounts and content. An obscure URL is not access control. If the owner requires the shell itself to be inaccessible before identity verification, define a Cloudflare Access identity policy before publishing; that extra gate is not implemented by this config and must be included in hosted/browser acceptance evidence.

This environment holds disposable development data. Recovery/TOTP and real iPhone/PWA acceptance remain pending. It does not authorize personal-data import, production use, DNS changes, custom domains, or changes to Deltos.

## Isolation and supported CLI behavior

Use an isolated staging checkout of the exact independently reviewed candidate, with its matching lockfile and local patches installed. Pin and record the candidate revision and any explicitly included uncommitted review diff. The main working tree's `.env.local`, generated files, running frontend, and anonymous backend must remain untouched.

This is necessary even when passing `convex dev --env-file`: installed Convex 1.45.0 `configure.ts` calls `updateEnvAndConfigForDeploymentSelection`, which invokes `writeDeploymentEnvVar` against `.env.local`. The flag controls target selection; it does not guarantee that the main checkout's default environment remains unchanged. A separately named environment file alone is insufficient isolation.

Installed `convex deployment create` supports an explicit `team:project:reference`, `--type dev`, and `--region`, with selection/default changes opt-in. The concrete provisioning command, when authorized and announced as a new development target, is:

```sh
pnpm exec convex deployment create jim-pringle:palladian:dev/hosted-pilot --type dev --region aws-us-east-1
```

Do not add `--select` or `--default`. Discover and record the returned deployment's actual name, canonical Convex data URL, and canonical auth HTTP URL. Before the first push, verify its type is `dev`, its reference is `dev/hosted-pilot`, and its team/project match. A newly encountered paid-plan requirement or unexpected billing upgrade is a decision to surface, not a reason to create another type of deployment.

## Configuration and publication sequence

1. Complete P1 runtime correction and independent review, including the unchanged-policy real-expiry test, before using the transport for the pilot. Hosted testing itself uses only disposable owner fixtures.
2. In the isolated checkout, configure the new development target explicitly. Clear inherited deployment/project keys and conflicting `CONVEX_*` target variables from child environments; use the already authenticated operator CLI identity. Preserve the main checkout's anonymous environment unchanged.
3. Set exactly `SITE_URL=https://palladian-development.rdxx.workers.dev` on the new development deployment. Generate a new high-entropy `BETTER_AUTH_SECRET` for this deployment and pass it through supported stdin or a restrictive temporary file, suppressing sensitive output. Do not copy the anonymous local secret. Leave the managed canonical `CONVEX_SITE_URL` intact. Do not add wildcard origins, alternate preview hosts, a proxy, or different credential storage.
4. Run the pinned official `convex dev --once` from the isolated checkout targeting the new development deployment; require actual CLI generation, strict typechecking, and successful code push. Never use bare `convex deploy` here: its documented default with `CONVEX_DEPLOYMENT` targets the project's production deployment. Announce the concrete development target before every push or environment mutation.
5. Set the frontend build's explicit `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` to the newly verified canonical URLs. Build with those environment values into the isolated ignored output directory:

```sh
pnpm exec vite build --config apps/web/vite.config.ts --outDir ../../.wrangler/palladian-development/assets
pnpm exec wrangler deploy --dry-run --config infra/cloudflare/development.wrangler.jsonc
```

6. Inspect the resulting asset manifest and required shell/auth bundle, verify that only the dedicated HTTPS backend URLs are present, and record the asset hash. Keep tokens, credentials, and signed URLs out of assets. The new Wrangler config has no R2 binding, Worker runtime, custom route, or hostname binding. Preview URLs are disabled so an unregistered alternate frontend hostname is not offered.
7. After the concrete reviewed result is ready and the parent has confirmed the hosted development action remains within the owner's authorization, publish this named development Worker using the same config. Confirm the returned URL is exactly the expected workers.dev origin and the deployment version matches the reviewed assets. The original `infra/cloudflare/wrangler.jsonc` remains unchanged.
8. Provision a disposable test owner using the internal provisioning function and a fully qualified new-development selector. Supply random fixture credentials only to the verified Palladian origin; suppress CLI/private response output. Establish the owner's eventual sign-in through a separate credential-delivery mechanism selected with the owner; do not invent, print, or commit a permanent password.

## Hosted proof before prototype handoff

Adapt a separate hosted acceptance harness with an explicit allowlisted development target. Existing `tests/auth/*.mjs` local guards require an anonymous backend and are intentionally not a cloud deployment harness; do not remove those protections globally.

Prove actual HTTPS Better Auth requests and Convex subscriptions, initial sign-in, reload with retained session, concurrent tabs, logout/account switch including delayed and denied old responses, server revocation with an unexpired JWT, hostile browser preflight/callback rejection, disabled OTT/social paths, transient-failure credential retention, and automatic reconnection after actual 900-second JWT expiry. Use the corrected lifecycle harness with genuine hidden/frozen/resumed observations. Record which failures were deliberately injected and which endpoints/browser interactions used real hosted services. Keep real iPhone/PWA proof separate and pending until actually performed.

Provide the owner the usable URL after the P0–P4 development pilot checkpoint, with the implemented capabilities and remaining acceptance limits. The shell alone is not a usable Notes/Recipes prototype.

## P3 storage follow-on

Create the dedicated R2 test bucket only when the P3 file contract is reviewed and ready to exercise actual bytes. Keep public bucket exposure and r2.dev access disabled. Grant backend-only credentials scoped to that bucket and configure exact-origin browser upload CORS only as required by the accepted upload design. Never ship R2 credentials to the frontend or bind an unrelated existing bucket. Test upload, server verification/finalization, download, failed finalization, and deletion with small disposable files before app integration. P1 preparation does not count as an R2 integration test.

## Validation performed and references

Preparation used read-only authenticated GET requests to the Cloudflare account/Worker subdomain/script/R2 listing APIs and Convex team/project/deployment metadata/region APIs. Returned tokens, account details, unrelated resource names, and application content were not printed. Installed Convex 1.45.0 and Wrangler 4.130.0 help/source/schema were inspected; no deployment command, data query, environment mutation, or production access was performed. The Convex capability catalog was reachable, and the repository's explicit Workers/R2 architecture was retained.

Official references: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Convex CLI](https://docs.convex.dev/cli/overview), and [R2 public-access controls](https://developers.cloudflare.com/r2/buckets/public-buckets/).
