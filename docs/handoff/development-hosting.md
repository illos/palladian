# Dedicated hosted development environment

Prepared 2026-09-10. This document records read-only discovery and a proposed deployment procedure. No cloud resource was created, deployed, modified, or deleted during preparation. P1 lifecycle acceptance remains the prerequisite for exposing the usable pilot.

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
