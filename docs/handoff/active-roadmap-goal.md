# Active roadmap goal — 2026-09-10

> **Superseded — deep sleep, 2026-09-26.** The owner has paused this entire roadmap indefinitely and returned focus to Deltos: a fast, MCP-first notes app. The ongoing authorization below is historical and must not trigger further work. See [the shelf and recovery record](deep-sleep.md). Resume only on a new explicit owner request.

The owner has assigned the roadmap as an ongoing goal, authorized subagents and independent adversarial review, and prioritized backend architecture. Notify the owner as soon as a usable development prototype exists, then work together on tools, components, and UI. This supersedes the historical requirement for a new owner assignment at every phase; independent protected-core acceptance remains required before downstream implementation.

Initial baseline: `b315159`; correction implementation: `14c0134`. P0 is independently accepted. P1's A07 response-ordering and stale-UI corrections now pass parent and independent real browser/service regressions. The corrected full 900-second A03 expiry run passed against immutable production assets. Independent review accepted P1 as the local P2 foundation in `351cac3`. P2 implementation and independent adversarial tests are underway; hosted acceptance is tracked separately. Existing owner edits in AGENTS.md, the specification, and handoff documents must be preserved.

## Execution order

1. Independently review P1 and its concrete correction proposals. Diagnose both failures, implement bounded corrections preserving the owner contracts, and independently rerun/review the acceptance evidence.
2. After P1 acceptance, implement and independently review P2: typed app instances, workspace ownership, resource authorization, semantic operations, conflicts, pagination, idempotency, and scoped preferences.
3. After P2 acceptance, implement and independently review P3: private R2 lifecycle and scoped search. Actual R2 integration is required; mocks alone cannot close the phase.
4. Deliver the minimum functional Notes and Recipes surfaces needed to exercise the accepted backend and collaborative persistence in P4. Keep optional tools and detailed UI design for collaboration with the owner. P0–P4 acceptance is the specification's foundation pilot milestone.
5. Continue the remaining roadmap with the owner, retaining all real-client, hosted-origin, iPhone, recovery, and release evidence requirements.

Each implementation has a separate independent review, and substantive fixes require regression evidence. Reports distinguish source checks, mocked faults, actual services, browsers, and physical devices. No phase is accepted merely because its build passes.

## Owner decisions and external prerequisites

- Owner selected a **private hosted development URL** for the first usable prototype. Prepare separate development Convex and private R2 test resources and prove the actual hosted auth origin arrangement; local integration work remains a prerequisite. This authorizes development hosting, not production or real-data adoption.
- Dedicated cloud dev `necessary-lynx-217` (`dev/hosted-pilot`, not a default) is provisioned and configured in an isolated checkout. No application code or frontend has been published yet. See `development-hosting.md` for exact public target metadata and isolation details. Whole-site Cloudflare Access was offered as an optional additional gate; private accounts/data with a public sign-in page is the implementation default unless the owner selects otherwise.
- Phrase-based recovery remains an unresolved design requirement before personal-data adoption. Prepare a concrete supported design and alternatives before requesting a contract decision.
- Private R2 test bucket and any hosted development deployment need identified environment-specific access; do not borrow production credentials or existing Deltos data.
- Physical iPhone, real MCP clients, and authorized custom-domain tests remain pending until exercised. No emulation or simulated client substitutes for those results.

Production deployment, DNS changes, real-data migration, and old-infrastructure removal remain separate explicitly authorized tasks. Deltos is read-only reference.
