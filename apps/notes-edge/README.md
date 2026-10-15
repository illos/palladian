# `@palladian/notes-edge`

One Cloudflare Worker, `palladian`, on `workers.dev`. It serves:

1. **The notes SPA** (`apps/notes/dist`) as Workers Static Assets. Only the
   paths the Worker owns run code first (`/mcp`, `/authorize`, `/oauth/*`,
   `/.well-known/*`, `/connect`). Everything else comes straight from assets
   with single-page-application fallback.
2. **An OAuth 2.1 authorization server** for agent connections
   (`@cloudflare/workers-oauth-provider` 1.2.3, single-Worker `OAuthProvider`).
3. **The MCP endpoint** `/mcp` (`@modelcontextprotocol/server` 2.3.1). It calls
   Convex as the connected agent.

```
src/index.ts         OAuthProvider configuration, routing, discovery aliases
src/consent.ts       /authorize, /oauth/request/<key>, /oauth/approve, /oauth/deny, /connect
src/mcp/handler.ts   /mcp: per-request stateless MCP server, revoked connection → 401
src/mcp/tools.ts     the tools and the server instructions
src/mcp/results.ts   Convex failure → tool result mapping
src/jwt.ts           short-lived ES256 agent JWTs (Web Crypto)
src/convex.ts        Convex HTTP client with failure classification
src/convex-api.ts    typed Convex function references (see "Types")
contract/            compile-time proof that convex-api.ts matches the generated api
scripts/keygen.mjs   agent signing key generator
scripts/e2e.mjs      end-to-end check against wrangler dev and a local Convex backend
```

## Configuration

| Name                    | Kind       | Value                                                                                                                                                                                                                                              |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`         | var        | Exact public origin, e.g. `https://palladian.<account>.workers.dev`. HTTPS, except `http://localhost`/`127.0.0.1` for local dev. The OAuth issuer, resource (`${PUBLIC_ORIGIN}/mcp`) and note URLs (`${PUBLIC_ORIGIN}/notes/<id>`) derive from it. |
| `AGENT_JWT_ISSUER`      | var        | `iss` of agent JWTs. Must equal Convex's `AGENT_JWT_ISSUER`. Use `PUBLIC_ORIGIN` in production.                                                                                                                                                    |
| `CONVEX_URL`            | var        | Convex deployment URL (`https://<name>.convex.cloud`).                                                                                                                                                                                             |
| `AGENT_JWT_PRIVATE_KEY` | **secret** | Private ES256 JWK as one line of JSON, with a `kid`. Never put it in `wrangler.jsonc`.                                                                                                                                                             |
| `OAUTH_DB` / `OAUTH_KV` | D1 or KV   | Grants, tokens (stored hashed), DCR clients, pending consent requests. Production binds D1 (`OAUTH_DB`), adapted to the KV interface by `src/d1-kv.ts`, because the deploy token lacks KV permission; binding `OAUTH_KV` uses KV directly.         |
| `ASSETS`                | assets     | `../notes/dist`. Build the SPA first.                                                                                                                                                                                                              |

`wrangler.jsonc` holds the production values: origin
`https://palladian.rdxx.workers.dev`, Convex production `adamant-hound-861`,
and the `palladian-oauth` D1 database. Compatibility flag
`global_fetch_strictly_public` is required for Client ID Metadata Documents
(SSRF protection on outbound metadata fetches). `nodejs_compat` is not needed.

### Deploying

Production secrets live in the shared Presidium secrets file under the
`palladian-notes` set: the auth secret, the agent signing key (base64url of the
private JWK) and its public JWKS. Convex production holds `SITE_URL`,
`BETTER_AUTH_SECRET`, `AGENT_JWT_ISSUER` and `AGENT_JWT_JWKS`; the Worker holds
the secret `AGENT_JWT_PRIVATE_KEY`. From a pushed commit on `main`:

```sh
(cd apps/notes-backend && npx convex deploy -y)      # backend to production
presidium-env -- apps/notes-edge/scripts/deploy.sh   # SPA build + Worker
```

To rotate the agent signing key, generate a pair, set the Worker secret and
Convex `AGENT_JWT_JWKS` together, and update the secrets file:

```sh
node scripts/keygen.mjs /tmp/agent-key.json /tmp/agent-jwks.txt
npx wrangler secret put AGENT_JWT_PRIVATE_KEY < /tmp/agent-key.json
(cd ../notes-backend && npx convex env set --prod AGENT_JWT_JWKS "$(cat /tmp/agent-jwks.txt)")
```

`keygen.mjs` writes both files with mode 0600, refuses to overwrite and never
prints the private key. The public JWKS is a
`data:text/plain;charset=utf-8;base64,…` URI, the form `auth.config.ts` reads
from `AGENT_JWT_JWKS`.

## OAuth

- **Discovery** (MCP 2026-07-28 / RFC 9728 / RFC 8414). An unauthenticated
  `/mcp` request gets `401` with
  `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="notes"`.
  Authorization server metadata is at `/.well-known/oauth-authorization-server`.
  Two aliases serve clients that guess paths: the protected resource document
  at the root `/.well-known/oauth-protected-resource`, and AS metadata at
  `/.well-known/oauth-authorization-server/mcp`.
- **Client registration**: Client ID Metadata Documents (claude.ai and ChatGPT
  use these) and Dynamic Client Registration at `/oauth/register` (Claude Code
  and Codex CLI). PKCE S256 is required for public clients. RFC 9207 `iss` is on
  every authorization response.
- **Endpoints**: authorize `/authorize` (ours), token and revocation
  `/oauth/token` (library).
- **Lifetimes**: access tokens 1 hour. Refresh tokens **never expire**
  (`refreshTokenTTL: undefined`). DCR client registrations never expire either
  (`clientRegistrationTTL: undefined`), because an expired registration would end
  an idle connection just as surely. Refresh tokens rotate. The previous token
  stays valid until its replacement is first used, so a lost refresh response
  never strands a client. A connection lasts until the person revokes it.

### Scope decision

Content authorization is notebook and note sharing in Convex, never OAuth
scopes, so scopes exist only to let every client sign in:

- `notes` is the single advertised resource scope (protected resource
  `scopes_supported` and the `401` challenge), so conforming clients request
  exactly it. It means "act as this agent" and grants no content.
- Authorization server `scopes_supported` is `["notes", "offline_access"]`.
- Every grant carries `notes` whatever was requested: nothing, `notes`,
  `offline_access`, or unknown scopes such as `openid`. `offline_access` is
  added when requested. Clients requesting no scope therefore succeed, and later
  token or refresh requests naming `notes` can never fail with `invalid_scope`.
- The MCP handler does not check scopes. Any valid token for `/mcp` may call any
  tool, and Convex decides what the agent can see or change.

## Consent contract (SPA ↔ Worker ↔ Convex)

```
client ──GET /authorize?…──▶ Worker: parseAuthRequest + describeConsent
                              KV put connect:<key> (10 min) ──302──▶ /connect?request=<key>
SPA /connect ──GET /oauth/request/<key>──▶ Worker
SPA (signed in) ──api.connections.approve──▶ Convex  → { code, agentId }
SPA ──POST /oauth/approve { request, code }──▶ Worker: delete KV entry, api.connections.redeem,
                              completeAuthorization → { redirectTo }
SPA ──location = redirectTo──▶ client callback (?code&state&iss)
```

**`GET /authorize`**: validates the request with the library. Invalid requests
render a small HTML error page. The only redirect is the library's own error
redirect, which exists only after the client and exact redirect URI were
validated. A valid request is stored under `connect:<32 random bytes, base64url>`
with a 10-minute TTL, then `302 /connect?request=<key>`.

**Browser binding.** The same 302 sets
`__Host-palladian-connect-<key>=<random secret>; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`.
KV stores only the secret's SHA-256. `GET /oauth/request/<key>`,
`POST /oauth/approve` and `POST /oauth/deny` refuse with `403` when the cookie
is missing or wrong, and a refused attempt does not consume the request. A
`/connect` link someone else started therefore cannot be approved by a
signed-in person it was sent to. The library's own consent helpers bind their
handle the same way. The SPA needs nothing extra, because same-origin `fetch()`
sends the cookie by default (`credentials: "same-origin"`). Approve and deny
clear the cookie.

**`GET /connect`**: the SPA's `index.html` from assets, plus
`Content-Security-Policy: frame-ancestors 'none'` (appended, so an SPA policy
still applies), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (the
URL carries the key) and `Cache-Control: no-store`.

**`GET /oauth/request/<key>`** → `200`:

```ts
{
  clientId: string;
  clientName: string; // falls back to redirectHost
  clientUri: string | null;
  logoUri: string | null;
  clientDomain: string | null; // verified domain of a CIMD client_id URL
  redirectHost: string;
  redirectIsLoopback: boolean;
  scopes: string[]; // what will be granted, e.g. ["notes"]
  expiresAt: number; // epoch ms
}
```

`clientName` falls back to `redirectHost` when the client gave none. Every
string except `redirectHost` and `clientDomain` is chosen by the client, so
render it as text only. Two fields go beyond the minimum, and the SPA should
show them as the MCP authorization spec asks. `clientDomain` is the verified
domain of a CIMD client's `client_id` URL; show it prominently. A DCR client's
name is self-asserted. When `redirectIsLoopback` is true, warn that access goes
to an app on this computer. A missing, expired or used key returns `404`
`{ "error": "…" }`; a request started in another browser returns `403`.

**Convex `api.connections.approve`** (called by the SPA as the signed-in person):
`{ requestKey: <key>, clientId, clientName, redirectHost, agentName, agentId?, notebooks: [{ notebookId, role }], autoShareRole? }`
→ `{ code, agentId }`. Pass `agentId` to reconnect an existing agent.

**`POST /oauth/approve`** with body `{ "request": "<key>", "code": "<code>" }`.
CSRF defense: requires `Content-Type: application/json` (a cross-site form
cannot send it without a preflight, which is never granted), `Origin` equal to
`PUBLIC_ORIGIN`, and `Sec-Fetch-Site` absent or `same-origin`. A browser
`fetch()` from the SPA satisfies all three. Responses:

| Status | Body             | Meaning                                                         |
| ------ | ---------------- | --------------------------------------------------------------- |
| 200    | `{ redirectTo }` | Navigate the window there (the client's callback).              |
| 400    | `{ error }`      | Bad body, invalid or expired code, or code made for another app |
| 403    | `{ error }`      | Cross-origin or cross-site request, or another browser          |
| 404    | `{ error }`      | Key missing, expired or already used                            |
| 415    | `{ error }`      | Not JSON                                                        |
| 502    | `{ error }`      | Convex unreachable                                              |

The KV entry is deleted before redemption, so a key works once, even on
failure. Convex's code is single-use and bound to the key. The Worker also
checks that the redeemed connection's `clientId` is the one that asked. The
grant is created with `userId = agentId`,
`props = { agentId, connectionId }`, `metadata = { connectionId }`. The library's
default `revokeExistingGrants` replaces an earlier grant of the same agent and
client.

**`POST /oauth/deny`** with body `{ "request": "<key>" }` and the same CSRF
rules. It deletes the entry and returns `{ redirectTo }`, the client callback
with `error=access_denied`, `state` and `iss`.

## MCP endpoint

- **Stateless.** Every request builds a fresh `McpServer` through
  `createMcpHandler`. It serves the 2026-07-28 protocol, and 2025-era Streamable
  HTTP clients through the SDK's built-in stateless legacy fallback (the
  default `legacy: "stateless"`; `GET`/`DELETE` answer 405). Tool input schemas
  are zod v4; the JSON Schema validator is `CfWorkerJsonSchemaValidator`
  (Workers forbid eval). `tools.listChanged` is `false`.
- **Calling Convex.** Per request the Worker reads `ctx.props`
  `{ agentId, connectionId }`. On the first tool that needs Convex, it mints an
  ES256 JWT: header `{ alg, typ: "JWT", kid }`; claims `iss`,
  `aud: "palladian-convex"`, `sub: agentId`, `cid: connectionId`, `iat`,
  `exp = iat + 300`. It then calls Convex with `ConvexHttpClient.setAuth`. The
  imported key is cached per isolate. Convex calls time out after 25 s.
- **Revocation.** Convex reports `unauthenticated` when the connection was
  revoked, or the agent or its person disabled. The tool call is then answered
  `401` with
  `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…", error="invalid_token", scope="notes", error_description="…"`.
  The Worker also revokes that OAuth grant. The client's refresh then fails with
  `invalid_grant`, so it starts a fresh sign-in instead of looping on refresh.
  Consequence: after disabling an agent, re-enabling it needs the client to sign
  in again. To produce a 401 rather than a tool error, tool-call responses are
  buffered until the exchange ends. They are bounded, and no tool streams.
  `library.notebooks` answers `[]` for unknown callers, so when it returns
  nothing `list_notebooks` confirms the connection with `library.recent`.
- **Tools.** Each returns concise text plus `structuredContent`, with
  `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint: false`
  annotations:
  `list_notebooks`, `search_notes`, `list_notes`, `read_note`
  (`markdown` | `outline`, paged by `offset`/`max_chars`), `create_note`,
  `edit_note` (atomic batch of the backend's edit union; `replace_all` requires
  `expected_revision`, enforced here), `trash_note`, `restore_note`,
  `create_notebook`, `note_history`, `read_revision`, `restore_revision`.
  Writes accept `request_id` where the backend supports it.
- **Errors.** `ConvexError` codes become `isError` results reading
  `Error (<code>): <message>`, with
  `structuredContent.error = { code, message, retryable }`. A failure after
  Convex ran the function (argument validation, for example a malformed ID)
  becomes `invalid`. Nothing was applied, because mutations are transactional.
  Network failures, timeouts and 5xx become `unavailable`, with a message saying
  the outcome is uncertain: retry with the same `request_id`, or check first
  where there is none.

## Types

The generated `api` in `apps/notes-backend/convex/_generated` gets its types
from the backend source, and that pulls Better Auth's Bun and DOM typings into
any program that imports it. Those typings conflict with the Workers runtime
types. So `src/convex-api.ts` names the functions the Worker calls with
`makeFunctionReference`. `contract/api-contract.ts`, compiled under the
backend's own compiler settings, proves for each one that the function kind
matches, the Worker's arguments are accepted, and the backend's return type fits
what the Worker reads. A backend change that breaks the Worker fails
`pnpm typecheck`. `src/types/buffer.d.ts` names the `Buffer` type the MCP
SDK's declarations mention, because Workers types declare it only as a value.

## Local development

A local Convex backend for `apps/notes-backend` must be running, with
`AGENT_JWT_ISSUER=http://localhost:8787`, the matching `AGENT_JWT_JWKS`, and
`SITE_URL=http://localhost:5178`. Create a gitignored `.dev.vars` (see
`.dev.vars.example`). Single-quote the JWK so dotenv keeps the JSON intact:

```sh
PUBLIC_ORIGIN=http://localhost:8787
AGENT_JWT_ISSUER=http://localhost:8787
CONVEX_URL=http://127.0.0.1:3228
AGENT_JWT_PRIVATE_KEY='{"kty":"EC",…,"kid":"…","alg":"ES256"}'
```

```sh
pnpm --filter @palladian/notes build          # once, for assets
cd apps/notes-edge
npx wrangler dev --port 8787 --ip 127.0.0.1
```

Use `http://localhost:8787`, not `127.0.0.1`. Tokens are bound to the
`PUBLIC_ORIGIN` resource, and the provider rejects requests on another host.

## Checks

```sh
pnpm --filter @palladian/notes-edge typecheck  # Worker, vitest config, API contract
pnpm --filter @palladian/notes-edge test       # vitest unit tests (mocks)
cd apps/notes-edge && npx wrangler deploy --dry-run --outdir dist   # bundle only
```

### End-to-end check (real services)

With `wrangler dev` running as above and the local Convex backend up:

```sh
cd apps/notes-edge
NOTES_BACKEND_DIR=/path/to/apps/notes-backend node scripts/e2e.mjs
```

`NOTES_BACKEND_DIR` is a backend checkout whose `.env.local` points at the local
deployment. The script runs `npx convex run provision:setupOwner` there.
Overrides: `WORKER_URL`, `CONVEX_URL`, `CONVEX_SITE_URL`, `SITE_ORIGIN`. Each
run makes a disposable account. It then:

1. Accepts the setup invitation with a random password, signs in through
   Better Auth's HTTP API (`Set-Better-Auth-Cookie` from the crossDomain
   plugin), and gets a Convex JWT from `/api/auth/convex/token`.
2. Runs real OAuth against the Worker: 401 challenge, protected resource and AS
   metadata, DCR, PKCE S256 authorize, `/connect` headers, request info,
   `connections.approve` as the person (default notebook, edit), refused
   cross-site and other-browser (no binding cookie) requests, approve, a
   refused key reuse, then the code and refresh exchanges.
3. Uses `@modelcontextprotocol/client` 2.3.1 pinned to 2026-07-28 for
   everything else: lists 12 annotated tools, creates a note from Markdown and
   replays its `request_id`, searches, lists, reads Markdown and outline, edits
   with `replace_text` and `set_checked`, reads history and revision 0, and
   checks that a note in an unshared notebook is invisible. A default
   (2025-era) client then lists tools and calls one through the stateless
   fallback.
4. Approves a second connection for the same agent, revokes both in Convex,
   and checks that the next tool call on both eras gets HTTP 401
   `invalid_token`, and that refresh then fails with `invalid_grant`.

It prints only non-secret progress lines and ends with `PASS`.
