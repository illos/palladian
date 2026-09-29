# Palladian notes app specification

Status: **discussion draft**, updated 2026-09-29. This package records the owner's notes-app direction and identifies the decisions still needed before a complete build. Writing these specifications does not authorize implementation or deployment.

Palladian is the working name in this conversation; final branding remains open. This is the original Deltos product goal: a fast, clean, MCP-first notes app. It is not the shelved app-hosting platform. The [platform shelf](../../handoff/deep-sleep.md), archive branch, and archive tag remain intact. Historical platform phases and their acceptance reports do not establish acceptance for this app.

## Read from the top down

| Document                                                        | Purpose                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [01 — Product](01-product.md)                                   | Purpose, priorities, scope, and confirmed owner decisions                         |
| [02 — User behavior](02-behavior.md)                            | Launch, navigation, editor, sharing, files, and reminders                         |
| [03 — Architecture and stack](03-architecture.md)               | Data authority, component boundaries, candidate technologies, and technical gates |
| [04 — Documents, collaboration, and history](04-documents.md)   | Revisions, live editing, agent checkout, and later offline conflict copies        |
| [05 — Identity and MCP](05-identity-and-mcp.md)                 | Session reliability, authorization, and efficient agent operations                |
| [06 — Decisions and acceptance](06-decisions-and-acceptance.md) | Missing information, recommended defaults, build gates, and evidence requirements |

## How to interpret this draft

- **Confirmed:** explicitly requested or agreed by the owner in the ongoing owner conversation.
- **Proposed:** a concrete implementation or product default offered for discussion; not an owner decision.
- **Open:** missing product information or a choice whose alternatives change the implementation materially.
- **Gate:** something engineering must demonstrate, rather than ask the owner to guess.

Discussion cadence: the owner prefers remaining questions in batches of three (updated 2026-09-29).

Sections marked proposed describe intended contracts if adopted. They are not claims that an existing library provides the behavior or that the feature has been built. Remaining items use stable `Qxx` identifiers in document 06; some are engineering contracts or later-task inputs rather than owner questions. Acceptance cases use `Axx` identifiers there.

The owner initially preferred full offline operation, then explicitly prioritized reliable online use and immediate cached viewing. Offline editing is now a later side branch, with revision-based conflict copies instead of mandatory automatic merging. This later direction supersedes earlier discussion of a full local-first synchronization foundation.

## Contract precedence

Each document owns a different level of detail: 01 summarizes the product; 02 owns visible behavior; 03 owns architecture proposals and gates; 04 owns document/collaboration contracts; 05 owns authorization and privacy; 06 preserves decision IDs and proof requirements. Later owner clarifications are applied throughout; the ledger identifies superseded wording. Proposed details never override confirmed behavior.

## Current authorization and evidence

On 2026-09-29 the owner authorized a scoped notes foundation and technical proofs with sub-agents and independent Astra review of auth and sync. Evidence and remaining gates are recorded in [foundation implementation](../../reviews/notes-foundation-implementation.md) and [independent review](../../reviews/notes-foundation-astra-review.md). This does not authorize production deployment or establish complete v1 acceptance. Deltos, live data and the platform shelf remain untouched. Full acceptance cases remain pending unless explicitly evidenced in those reports.

Further implementation should use a separately assigned scope and resolve its blocking technical gates. Protected changes to authentication, authorization, collaborative persistence, agent scopes, and file access need independent review before acceptance. The old P0–P9 roadmap is not the execution plan for these documents.

## Source context

- Owner discussion in the project thread **Choose Notes Sync Architecture**, 2026-09-26.
- Deltos read-only reference: `/srv/presidium/projects/deltos/code/brain/knowledge/ROAD-0022-auth-rewrite-better-auth.md` and `docs/design/auth-rewrite/auth-overhaul-findings.md` under that checkout.
- Deltos editor reference: `packages/client/src/editor/ProseMirrorEditor.tsx`, `schema.ts`, and `inputRules.ts` under that checkout.
- [Preserved authentication investigation](../palladian-platform-v1.md#5-authentication-and-startup-protected-core) and [MCP v2 decision](../../decisions/0001-runtime-and-auth.md#mcp-v2-only-compatibility-plan). These provide evidence and context, not authorization to resume the platform.
- External technical sources appear beside the relevant proposals. Reverify supported APIs and compatible versions when implementing; this draft does not pin a new dependency graph.

Specification coherence review: [review findings](../../reviews/notes-spec-coherence.md). External technical references are discussion-time context and must be rechecked when implementing; this review accepts no library integration.
