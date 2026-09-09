# P0 isolated auth compatibility spike

This is fixture-only code, excluded from the web bundle and root backend. The runtime refuses non-loopback auth origins. It uses real Convex and Better Auth, with CLI-generated `_generated` files. Email/password signup is enabled only here to create disposable identities; it is not the P1 provisioning design.

From the repository root, install the pinned dependencies. In this directory run `CONVEX_AGENT_MODE=anonymous ../../node_modules/.bin/convex dev --typecheck disable` to create/start an anonymous local backend. Never supply a cloud deployment or deploy key. The observed endpoint pair is 3214/3215; the probe intentionally hardcodes loopback to prevent accidental remote fixture writes. If the CLI chooses other ports, update these probe constants after verifying the local target.

After the local backend is running, run `node setup-secret.mjs` once. It validates the anonymous deployment and exact loopback ports, refuses deployment environment overrides, generates a random `BETTER_AUTH_SECRET`, and suppresses CLI output. Rerunning rotates only this disposable fixture secret and invalidates its existing signed credentials. No secret is checked in. Then run:

```
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
node probe.mjs
```

The probe prints only scenario/status information. Fixture emails, passwords, cookies, sessions, and JWTs remain in memory or the ignored local backend. Failed runs can leave fixture sessions; discard the isolated local deployment after review. Never export it or reuse it with real content.

Observed 2026-09-09: fixture signup; two independent sessions; session retrieval with retained credential; 365-day expiry; eight concurrent token requests; 900-second JWT; authenticated real Convex query; token retry after deliberately discarded successful response; revoke from another session; denial with unexpired JWT; surviving second session; revoked credential rejection; signout. All used Node HTTP clients and a real local Convex process, without auth mocks. The probe uses a minimal header jar, not the browser client plugin.

Untrusted Origin with an explicitly supplied `Better-Auth-Cookie` header received HTTP 200 on signout. This is recorded as an observation requiring CORS/browser transport review, not an accepted origin-policy test. It does not demonstrate that a hostile browser origin can obtain or send another origin's credential. See the ADR for source evidence and pending checks.

Pending: official browser client storage/reload/multitab tests, browser CORS/preflight/CSRF, actual hosted origin arrangement, 429/5xx/timeouts, simulated expiry/daily sliding boundaries, backgrounded iPhone/PWA, private owner provisioning, recovery/TOTP, and agent-grant independence. This P0 spike does not satisfy P1 acceptance.

Stop `convex dev` with Ctrl-C after the probe. Its ignored `.convex/` and `.env.local` contain local state; never commit, upload, or copy them to another project. To start fresh, stop the process first and remove only this spike’s local state/config after confirming the path and that no review needs it. Never run a general deployment reset or remove shared Convex home state. Failed runs can leave fixtures; successful probes revoke/sign out sessions but retain disposable auth user rows until this isolated state is discarded.

`node browser-cors.mjs` starts disposable blank frontend HTTP servers on 127.0.0.1 ports 5173 and 5176 and uses Playwright Chromium against the real local auth endpoint. On 2026-09-09 both checks passed: localhost:5173 can read the response to a custom-header request, whereas the unregistered 127.0.0.1:5176 origin cannot. The request carries no real credential. This proves this local browser CORS arrangement only; hosted origins, official auth-client persistence, authenticated browser flows and iPhone remain pending. Install the matching Playwright browser with the root documented procedure before running. Free these ports first; do not terminate unrelated services.
