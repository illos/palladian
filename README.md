# Palladian

P0 foundation for the platform specified in [the specification](docs/specs/palladian-platform-v1.md). The responsive shell offers light/dark/system themes and two explicitly empty, lazy app previews. Authentication is a separate disposable compatibility spike; the web app does not sign in, create instances, or persist private data yet.

Use Node **24.18.0** and pnpm **11.5.3**:

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm dev
```

Open `http://127.0.0.1:5173`. The shell needs no environment variables or network backend. Dependencies are centrally pinned in the root workspace; shared packages are source-only and private.

```sh
pnpm check
pnpm format:check
pnpm --filter @palladian/auth-spike typecheck
pnpm exec playwright install chromium
pnpm test:browser
pnpm hosting:check
pnpm audit
```

`check` runs strict TypeScript, AST-based import rules, negative boundary tests, production build, and the lazy-chunk/bundle budget check. Browser tests use the production build, so run `check` first. `hosting:check` performs only a Workers Static Assets dry run; no deployment. CI runs local checks and browser tests, not the live auth probe. See [the spike procedure](spikes/auth/README.md) for the isolated actual-service probe.

Build output is `apps/web/dist`. Cloudflare configuration is in `infra/cloudflare/wrangler.jsonc`; no account, domain, R2 binding, or production environment is configured. P0 has no service worker. Auth integration, instances, persistent app data, file lifecycle, and installable PWAs belong to later reviewed phases. Client-safe logical IDs in `packages/contracts` are not generated database IDs; P2 must adapt using actual generated Convex table IDs.

Read [the runtime/auth decision](docs/decisions/0001-runtime-and-auth.md) and [P0 implementation evidence](docs/reviews/P0-implementation.md). Stop at independent P0 review before P1. Deltos remains untouched.

## P1 development identity and sessions

P1 is a review candidate with blocking browser findings. Read [P1 implementation evidence](docs/reviews/P1-implementation.md) and [ADR 0002](docs/decisions/0002-p1-identity-sessions-recovery.md) before using it. Use development data only. Phrase recovery/TOTP, hosted origins and iPhone/PWA evidence are pending. No production deployment or P2 work is authorized by these instructions.

The root `convex/` backend is separate from the P0 spike. Start a new anonymous local deployment with `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --typecheck disable --tail-logs disable`. Classify the selected target first; never pass a cloud deployment/deploy-key override. The expected root local pair is 3214/3215. The CLI creates ignored `.env.local` with the public Vite data/auth URLs and generates the actual backend types. Run `pnpm typecheck` separately (it checks library declarations too).

Run `node scripts/setup-local-auth.mjs` to initialize the exact localhost frontend origin and a fresh secret only when missing. It refuses conflicting origins and preserves an existing secret. No values belong in source control. The frontend reads the two public URLs from the root `.env.local`. `pnpm dev` serves it; open **localhost:5173**, not the unregistered 127.0.0.1 frontend origin.

For a private owner, create an ignored, owner-readable `.env.provision.local` with `PALLADIAN_OWNER_EMAIL`, `PALLADIAN_OWNER_NAME`, and a 16–128 character `PALLADIAN_OWNER_PASSWORD`. Run `node --env-file=.env.provision.local scripts/provision-owner.mjs`. This invokes an internal action using library credential handling, prints no credentials, and refuses nonlocal targets. Delete the local input file after provisioning if no longer needed. Do not put passwords in shell command literals. This utility deliberately does not provision production or reset existing passwords.

With the local backend and Vite **development** server running:

- `node tests/auth/p1.mjs`: real official-browser/session suite with controlled network faults and admin-only fixture timestamps.
- `node tests/auth/origins.mjs`: real authenticated browser preflight and callback checks; **currently fails hostile callback rejection**. Port 5176 must be free for the untrusted-origin fixture.
- `node tests/auth/stale-response.mjs`: real delayed-sliding/account-switch regression; **currently fails**.
- `pnpm test:auth:p1`: aggregate short gate; intentionally exits nonzero while the transport findings remain unresolved. Run individual files to see both failures because the aggregate stops at the first.

For the production-build desktop resume/timing checks, stop the Vite development server, run `pnpm build`, then `pnpm exec vite preview --config apps/web/vite.config.ts --port 5173` while keeping the same local Convex backend running:

- `pnpm test:auth:resume`: freezes a real Chromium tab until the real 900-second JWT expires; verifies the expired token is rejected and observes the existing official provider automatically acquiring a valid token after resume, without reload or direct token demand. Allow roughly 16 minutes. Do not modify/rebuild the served assets while it runs.
- `node tests/auth/performance.mjs`: six cold-cache and six warm-cache production loads with persisted fixture credentials, actual browser FCP and authenticated-data timing, plus allowlisted diagnostic export verification. No iPhone performance claim.

Tests print only statuses/allowlisted metrics. Browser traces, credential-bearing storage-state files and private screenshots are not produced. Test accounts/session-age edits remain in the ignored disposable local backend; never reuse/export this state for real data. Stop only the processes you started when finished. The original P0 spike's evidence and limitations remain in its own README/reviews.
