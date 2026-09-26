# Palladian notes app specification

Status: **discussion draft**, 2026-09-26. This package records the owner's notes-app direction and identifies the decisions still needed before a complete build. Writing these specifications does not authorize implementation or deployment.

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

- **Confirmed:** explicitly requested or agreed by the owner in the 2026-09-26 conversation.
- **Proposed:** a concrete implementation or product default offered for discussion; not an owner decision.
- **Open:** missing product information or a choice whose alternatives change the implementation materially.
- **Gate:** something engineering must demonstrate, rather than ask the owner to guess.

Sections marked proposed describe intended contracts if adopted. They are not claims that an existing library provides the behavior or that the feature has been built. Questions use stable `Qxx` identifiers in document 06. Acceptance cases use `Axx` identifiers there.

The owner initially preferred full offline operation, then explicitly prioritized reliable online use and immediate cached viewing. Offline editing is now a later side branch, with revision-based conflict copies instead of mandatory automatic merging. This later direction supersedes earlier discussion of a full local-first synchronization foundation.

## Current authorization and evidence

This work is documentation only. No application behavior, backend schema, credentials, deployment, DNS, live notes, or Deltos files are changed. No runtime, real-service, browser, or iPhone behavior is accepted by this package. All acceptance cases remain pending.

Implementation should begin with a separately assigned scope and resolved blocking decisions. Protected changes to authentication, authorization, collaborative persistence, agent scopes, and file access need independent review before acceptance. The old P0–P9 roadmap is not the execution plan for these documents.

## Source context

- Owner discussion in the project thread **Choose Notes Sync Architecture**, 2026-09-26.
- Deltos read-only reference: `/srv/presidium/projects/deltos/code/brain/knowledge/ROAD-0022-auth-rewrite-better-auth.md` and `docs/design/auth-rewrite/auth-overhaul-findings.md` under that checkout.
- Deltos editor reference: `packages/client/src/editor/ProseMirrorEditor.tsx`, `schema.ts`, and `inputRules.ts` under that checkout.
- [Preserved authentication investigation](../palladian-platform-v1.md#5-authentication-and-startup-protected-core) and [MCP v2 decision](../../decisions/0001-runtime-and-auth.md#mcp-v2-only-compatibility-plan). These provide evidence and context, not authorization to resume the platform.
- External technical sources appear beside the relevant proposals. Reverify supported APIs and compatible versions when implementing; this draft does not pin a new dependency graph.
