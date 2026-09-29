# Disposable notes service proof

This is an isolated experiment, not the shelved platform or a deployed v1. It owns a fresh anonymous local Convex backend. No real accounts, notebooks, data, email delivery, or production deployment are touched. Fixture passwords and session/token values never appear in evidence output.

## Run

Install the workspace with the repository's pinned pnpm version. From this directory, classify the target as **local-anonymous** before running:

```sh
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --local-cloud-port 3218 --local-site-port 3219
```

The deployment requires `SITE_URL=http://localhost:5178`, a newly generated secret of at least 32 characters in `BETTER_AUTH_SECRET`, and `NOTES_LOCAL_FIXTURES=1` for disposable fixture provisioning. Set these only on this newly configured local deployment. Never print the secret. Keep the backend running while executing `pnpm prove`.

Actual generated Convex API/server/data-model files remain ignored; `convex dev` regenerates them. They must never be hand-written. The proof uses the pinned Better Auth component and the repository's existing supported auth patches. A standalone install must preserve those patches through the root workspace configuration.

## Contracts proven here

Password sign-in creates a persisted session; short-lived Convex JWTs are issued from that session. Public signup is disabled. Only the internal fixture mutation, guarded by both loopback deployment URL and the explicit fixture flag, can provision disposable users. It also writes trusted human/agent identity kinds; clients cannot choose their principal kind.

The session lasts 365 days with one-day renewal age. Production JWT configuration is 15 minutes; the fixture flag shortens it to five seconds to exercise renewal. This does not prove a year of elapsed use. `session-transport.ts` performs supported Better Auth session checks outside the launch pipeline: null means expired, transient errors preserve state, and it does not infer explicit device revocation from a missing session.

Notes accept ProseMirror steps at a known revision, not replacement bodies. A server wrapper validates and applies those steps, protects the actual changed paragraphs, and submits them to `@convex-dev/prosemirror-sync`. The wrapper owns snapshots; no public arbitrary snapshot endpoint exists. Old base versions return component steps for rebasing. Request receipts bind actor, note, ID, exact payload and accepted revision. Authorization precedes replay; replay after another edit returns the original acceptance without another history entry.

Claims have generations and expiry. Authorized human editors can cancel, and a durable reactive status records cancellation. A trusted fixture agent must submit a claim; it cannot omit the cancelled generation to bypass interruption. Actual paragraph changes are compared server-side, including ordering. This conservative ordering check also rejects inserting unrelated paragraphs before a claimed paragraph. Precise structural scope needs further work.

## Deliberate proof limits

- Paragraph-only schema, 100 KB document and 32-step batch guards are experiment bounds, not product limits or the final editor schema.
- Shared editors are direct local fixture invitations. Complete notebook/note overrides, public access and MCP principal registration are pending.
- The HTTP probe explicitly rebases competing steps; browser subscriptions/editor lifecycle and durable client recovery are separate proofs.
- Claims currently cover one paragraph; atomic successful-edit release, multiple-paragraph claims, live interruption notifications and human in-flight recovery remain pending.
- Every accepted batch retains a server-derived snapshot and metadata receipt. This proves reconstruction foundations, not efficient lifetime history, history restore, compaction or long-history read costs.
- Public read APIs are bounded to one current note or twenty history entries. Component rebase reads are internally capped by delta batches, but total payload/performance across long histories is not accepted.
- Known device revocation requires a separate authoritative signal; expiry and generic network errors cannot prove it. Password reset email delivery, invitation verification, browser reload/resume, multi-tab renewal and real iPhone performance remain pending.
