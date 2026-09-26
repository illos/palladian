# Palladian implementation instructions

## Current notes-app specification work

The owner explicitly authorized a new notes-app specification on 2026-09-26. Read `docs/specs/notes-app/README.md` and its linked documents for that product direction. Confirmed decisions, proposals, open owner questions, and technical gates are labeled separately. This authorization covers specification work, not implementation or deployment. The archived platform phases below remain historical; do not use them as the execution plan for the notes app. Deltos remains read-only reference. Preserve the platform shelf and its archive branch/tag.

## Historical app-hosting-platform instructions

> **Owner direction — deep sleep, 2026-09-26.** This entire app-hosting-platform effort is shelved. Do not resume implementation, review, or deployment from an old phase assignment or ongoing-roadmap instruction. The current product focus is the original Deltos goal: a fast, MCP-first notes app. Resume Palladian only on a new explicit owner request. See `docs/handoff/deep-sleep.md` for preserved work and recovery. All phase instructions below are historical while shelved.

Read `docs/specs/palladian-platform-v1.md` and the assigned phase in `docs/handoff/execution-plan.md` before implementation. This repository begins as a specification handoff, not an existing application.

- Implement the phase assigned by the user. If using the initial handoff prompt, that phase is P0 only.
- The owner wants implementation followed by independent review. Produce a phase report and stop at the assigned checkpoint; do not self-approve protected-core changes.
- Do not change auth/session lifecycle, authorization, collaborative persistence, agent scopes, file lifecycle, or hostname trust to get a test passing. Propose a concrete contract change for review if required.
- Use Convex for authoritative structured data, Cloudflare Workers Static Assets for frontend hosting, and private R2 for object bytes. Better Auth integration is subject to the compatibility gate. No local-first sync engine.
- The existing `/srv/presidium/projects/deltos/code` tree is read-only reference. Do not execute its old migration/cutover plan as part of this build.
- Apps are trusted build-time code. Do not introduce runtime code execution or claim namespaces are a sandbox.
- Do not deploy production, change DNS, move real data, or delete old infrastructure without a separate explicit task authorizing that action.
- Use current supported library APIs and generated types. No fake Convex generated files, auth bypasses in production, broad `any`, ignored type errors, or weakened acceptance tests.
- Never print or commit credentials, session tokens, signed file URLs, private content, or recovery material.
- Report which checks used mocks, actual services, browsers, and a real iPhone. Unperformed checks stay pending.
- Record implementation evidence in `docs/reviews/<phase>-implementation.md` using the supplied template. Independent review goes in a separate file.

The specification distinguishes owner decisions from implementation defaults. User instructions in the active conversation take precedence; record consequential changes so the next implementer can follow them.
