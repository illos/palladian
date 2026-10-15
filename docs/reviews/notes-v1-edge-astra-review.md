# Notes v1 edge Worker — independent Astra review

Date: 2026-10-15

**Status: not accepted — required fixes before production use.**

**Scope:** commit `03eacab1d1425f09fd7a8aba3531e6718817af5a` (`feat/notes-core`): `apps/notes-edge`, its pinned OAuth/MCP dependencies, backend connection/authentication contract, and SPA consent page. Reviewed independently using the Convex reviewer checklist.

**Independent evidence**

- Created the requested detached worktree; `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @palladian/notes-edge typecheck` passed, including the backend API contract.
- Edge `npx vitest run`: **56 passed**, using fake services/KV and local cryptography.
- `pnpm --filter @palladian/notes build` passed.
- `npx wrangler deploy --dry-run --outdir dist` passed; no deployment performed.
- Backend `npx vitest run`: **27 passed**—23 existing tests plus four temporary adversarial probes using `convex-test` and mocked authenticated identities.
- Two temporary edge probes passed, demonstrating permanent anonymous registrations and concurrent consumption of one consent request.
- `scripts/e2e.mjs` passed against the existing local Worker and Convex services, using `NOTES_BACKEND_DIR=/srv/presidium/projects/palladian/code/.worktrees/notes-core/apps/notes-backend`. Exercised OAuth/PKCE, refresh, modern MCP operations, legacy fallback, unshared-note denial, and revocation → 401 / refresh rejection. These services were not redeployed by the reviewer. An initial attempt using the main checkout failed because it lacked deployment configuration.
- Confirmed `SITE_URL=http://localhost:5178`; skipped `browser-e2e.mjs` as instructed. No independent browser or physical-iPhone verification.
- Removed temporary probes, verified empty `git status --porcelain`, and removed the review worktree. No tracked files changed; no commits or pushes.

**BLOCKING — must fix before production use**

**1. High — self-declared client names select privileged existing agents.**

Locations: `apps/notes/src/pages.tsx:64`, `apps/notes/src/pages.tsx:76`, `apps/notes-backend/convex/connections.ts:43`.

The consent page matches agents solely by `clientName` and automatically selects the first match. The backend permits attaching that agent to a different `clientId`, retaining its memberships, explicit note grants, and delegations.

**Failure scenario:** an attacker registers a client named “Claude” and gets an owner to open its authorization URL. The page defaults to reconnecting the owner’s existing Claude agent. Clicking Allow gives the attacker’s client that established identity. This requires user interaction; it is not a silent authentication bypass.

The backend probe reproduced a distinct client inheriting edit access, successfully reading/editing a synthetic note, and retaining existing `share`/`delete` delegations. The Worker’s client-ID comparison does not prevent this: the new connection contains the attacker’s client ID.

**Fix:** never infer identity continuity from display names. Bind reconnect eligibility to the established client identity and appropriate redirect/domain constraints. Require explicit confirmation for transferring an existing agent to another client. Display CIMD’s verified domain, identify DCR names as self-declared, and show the supplied loopback warning; the current page ignores those fields.

**2. High — “No access” and unchecked future sharing do not remove permissions.**

Locations: `apps/notes/src/pages.tsx:103`, `apps/notes-backend/convex/connections.ts:48`, `apps/notes-backend/convex/connections.ts:63`.

The page omits notebooks selected as “No access.” Approval only inserts/updates submitted memberships; it never removes omitted ones. An unchecked future-sharing checkbox likewise omits `autoShareRole`, preserving the existing value.

**Failure scenario:** reconnect an agent, select “No access” everywhere, leave future sharing unchecked, and approve. Despite the page saying the agent will see no notes, it retains existing access and receives newly created notebooks.

The backend probe confirmed both retained current membership and automatic access to a subsequent notebook.

**Fix:** submit explicit permission changes, including removals and a nullable future-sharing setting, and apply them transactionally. Initialize controls from persisted settings. Explain any retained explicit note grants or delegations so the consent summary reflects effective authority.

**3. Medium — anonymous registration creates permanent, unbounded KV records.**

Location: `apps/notes-edge/src/index.ts:53`, `apps/notes-edge/src/index.ts:69`.

DCR is public, registration TTL is explicitly disabled, and no application admission/rate/quota control is configured. Inspection of provider 1.2.3 confirms that each successful registration writes a fresh `client:*` record without expiry. The probe issued five anonymous registrations and verified five distinct permanent writes.

**Failure scenario:** a stranger repeatedly registers clients without ever authorizing one, consuming KV writes and permanently growing storage.

**Fix:** provide bounded registration admission and abuse controls before public exposure, with a policy for abandoned registrations that preserves authorized long-lived connections. Alternatively, demonstrate and document equivalent perimeter controls; none were verified in this review.

**NON-BLOCKING**

**4. Medium — connection retirement stops after 100 historical rows.**

Location: `apps/notes-backend/convex/connections.ts:131`.

`redeem` scans the first 100 connections, including already-revoked entries. Once those occupy the window, newer active connections escape retirement.

The probe seeded 100 revoked historical connections followed by an active connection, then reauthorized the same client. The previous connection remained active and its mocked JWT identity still passed backend authorization.

**Fix:** index/query active connections by agent and client, or use a generation-based revocation check. This is a backend revocation defect; the probe does **not** establish continued OAuth access after the provider independently revokes the corresponding grant.

**5. Low — pending consent consumption is not atomic.**

Locations: `apps/notes-edge/src/consent.ts:214`, `apps/notes-backend/convex/connections.ts:92`.

`takeBound` performs separate KV read and delete operations. Two concurrent requests can both load the same entry. Backend approval uniqueness is per code, not per request key.

The edge probe completed authorization twice concurrently using distinct approval codes. A separate backend probe confirmed that two approvals for the same request key are independently redeemable.

**Fix:** enforce transactional, one-time request-key consumption alongside approval redemption. Browser binding and individual code single-use remain effective; this finding does not demonstrate cross-browser access.

**Remaining release gates**

- Fix the blocking findings and independently retest consent identity continuity and permission reduction.
- Run the real consent browser flow with compatible configuration, including malicious duplicate names, CIMD domains, loopback warnings, and reconnect permission changes.
- Exercise actual claude.ai, ChatGPT, Claude Code, Codex CLI, Hermes, and Presidium invocation paths; SDK clients do not establish those integrations.
- Verify production JWT rejection/expiry behavior, clock-skew allowance, key rotation/JWKS caching, deployed consent headers, CIMD SSRF restrictions, and registration abuse controls.
- Complete physical-iPhone/Safari checks and production configuration validation.
