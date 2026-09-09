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
