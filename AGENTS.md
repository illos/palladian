# Palladian implementation instructions

Read `docs/specs/palladian-platform-v1.md` and the assigned phase in `docs/handoff/execution-plan.md` before implementation. This repository begins as a specification handoff, not an existing application.

- Implement the phase assigned by the user. If using the initial handoff prompt, that phase is P0 only.
- The owner wants implementation followed by independent review. Produce a phase report and stop at the assigned checkpoint; do not self-approve protected-core changes.
- Do not change auth/session lifecycle, authorization, collaborative persistence, agent scopes, file lifecycle, or hostname trust to get a test passing. Propose a concrete contract change for review if required.
- Use Convex for authoritative structured data, Cloudflare Workers Static Assets for frontend hosting, and private R2 for object bytes. Better Auth integration is subject to the compatibility gate. No local-first sync engine.
- The existing `/srv/presidium/projects/deltos/code` tree is read-only reference. Do not execute its old migration/cutover plan as part of this build.
- Apps are trusted build-time code. Do not introduce runtime code execution or claim namespaces are a sandbox.
- MCP targets SDK v2 and protocol `2026-07-28` only initially. Disable legacy defaults. Add minimal legacy support only after a real ChatGPT, Codex, or Claude Code test confirms lack of new-protocol support, as defined in the spec; missing documentation is not evidence of incompatibility.
- Do not deploy production, change DNS, move real data, or delete old infrastructure without a separate explicit task authorizing that action.
- Use current supported library APIs and generated types. No fake Convex generated files, auth bypasses in production, broad `any`, ignored type errors, or weakened acceptance tests.
- Never print or commit credentials, session tokens, signed file URLs, private content, or recovery material.
- Report which checks used mocks, actual services, browsers, and a real iPhone. Unperformed checks stay pending.
- Record implementation evidence in `docs/reviews/<phase>-implementation.md` using the supplied template. Independent review goes in a separate file.

The specification distinguishes owner decisions from implementation defaults. User instructions in the active conversation take precedence; record consequential changes so the next implementer can follow them.
