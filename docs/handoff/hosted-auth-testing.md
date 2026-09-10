# Dedicated hosted-development P1 acceptance harness

Status: authored for independent review; **not executed or accepted**. This harness does not authorize publishing, provisioning or production changes. The parent must first confirm that the dedicated hosted code is published and the target verified. Existing anonymous-local test guards remain unchanged.

## Exact target and invocation

The harness pins:

- Checkout: `/srv/presidium/projects/palladian/hosted-dev`.
- Team/project/reference: `jim-pringle:palladian:dev/hosted-pilot`.
- Deployment: `necessary-lynx-217`, type `dev`, not the default deployment.
- Frontend: `https://palladian-development.rdxx.workers.dev`.
- Convex data: `https://necessary-lynx-217.convex.cloud`.
- Auth HTTP: `https://necessary-lynx-217.convex.site`.

After the publication/target checkpoint, run from the implementation checkout:

```sh
node tests/auth/hosted.mjs --target jim-pringle:palladian:dev/hosted-pilot
```

Do not pass `CONVEX_*` environment overrides; they are rejected. `hosted-target.mjs` checks the isolated public metadata file, public-only environment, exact official live project/deployment metadata, canonical backend URLs and frontend origin, and the Palladian production HTML before making a fixture available. The browser additionally checks the loaded build's exact public URLs and successful anonymous auth response before fixture provisioning. Its initial page requests allow only the three expected origins. A changed deployment or URL requires a reviewed harness update, not a default-target fallback.

Only `provision:owner` is called through the operator CLI, always with the fully qualified development selector and isolated checkout cwd. Provisioning credentials are random, held in memory and passed directly as structured argv to the child process; argv/stdout/stderr are never printed. The operator access token is read from the existing Convex login and used only in in-memory HTTPS authorization headers for exact metadata reads. No key/token/secret is written by this harness.

## What the harness is designed to prove

Nine scenario groups use actual deployed services and production browser flows:

1. The nondefault development identity, exact public URLs, built frontend, secure context and Web Locks agree before fixtures.
2. Public email/password signup remains disabled.
3. Real sign-in maps to a protected identity, reload retains it, and a second shared-storage browser tab resolves the same identity.
4. Deliberately injected 429/503/network failures leave the shell visible, retain the credential jar, and recover to the same identity through the existing Retry button. These are **transport fault injections**, not naturally occurring hosted faults or independent auth mocks.
5. A separately signed-in browser context revokes the first device through the shipped UI. The first device's captured, still-unexpired JWT receives a null protected-identity result, while the independent device retains its identity.
6. Switching the first browser to B changes its protected identity and B's attempt to revoke a live A session fails specifically with the server's `NOT_FOUND` ConvexError. A remains valid.
7. A synthetic hostile HTTPS browser origin attempts a credentialed signout. Browser blocking, explicit denied CORS response headers, and continued positive B access are required. The hostile page is test HTML supplied through Playwright interception, which is removed before the credentialed request: the pinned Playwright routing layer otherwise synthesizes a permissive OPTIONS response. The auth endpoint and its preflight are the actual hosted endpoint.
8. An invalid absolute callback receives `403 / INVALID_CALLBACK_URL`, and the unused OTT endpoint receives `404`; B remains valid.
9. UI signout clears private state and revokes the corresponding hosted session.

JWTs are observed only in the official provider's real `/api/auth/convex/token` responses. Positive and negative assertions then use the generated public Convex APIs. No `/src` import, provider invocation, fake identity, shortened JWT lifetime, server timestamp edit or admin bypass supplies authenticated behavior. Temporary browser fault responses are explicitly identified as injections. The test exports neither traces/screenshots nor response bodies/credentials/private content; errors print only the fixed scenario label.

Best-effort cleanup revokes only the current sessions visible to the test's own captured fixture identities. Disposable accounts remain in the dedicated development deployment; the harness does not delete users, tables, data or infrastructure.

## Remaining evidence

Authoring this file and passing JavaScript syntax/format checks do not prove hosted behavior. Each scenario remains pending until execution against the verified publication and independent review. The current harness does not cover real-time 900-second hosted suspension/resume, age-adjusted daily sliding/expiry boundaries, hosted delayed-response/account-switch races, real iPhone/Safari/installed-PWA lifecycle and storage behavior, hosted custom-domain arrangements, TOTP/recovery, agent grants, real data, or v1 release acceptance.

The corrected `lifecycle-browser.mjs` browser launcher and freeze-event/timer proof can be reused by a separately reviewed hosted 900-second probe, but the anonymous-local guard in `resume.mjs` must not be relaxed or reused against cloud by changing a URL. No long hosted test is started by this smoke harness.
