# Copy this prompt into the coding-model session

You are implementing Palladian, a personal platform for small agent-built web apps. The repository is `/srv/presidium/projects/palladian/code`.

Read these files fully before editing:

1. `docs/specs/palladian-platform-v1.md`
2. `docs/handoff/execution-plan.md`
3. Applicable `AGENTS.md` and relevant installed skills.

**Your assignment is P0 only.** Build the minimal real foundation and compatibility evidence described there. Do not implement all phases at once. Do not deploy production or modify the existing Deltos application. Its source and brain are read-only reference for this task.

The goal is a coherent, testable increment for an independent reviewer. Resolve ordinary implementation choices yourself within the spec. Preserve the required architecture and behaviors. If a required library combination or auth behavior is unsupported, document the exact evidence and a concrete alternative for review; do not silently weaken the requirement.

Critical constraints:

- Convex is the authoritative app backend; Cloudflare hosts static frontend assets and private R2 objects.
- Better Auth + Convex must be verified for compatible versions and reliable long-lived sessions. Do not substitute Convex Auth or copy the old Deltos refresh state machine.
- Shell rendering cannot wait for authentication/network readiness.
- App data is typed and scoped; every public backend operation verifies identity and resource ownership.
- Apps are trusted build-time modules, not sandboxed arbitrary code.
- No local-first database or custom bidirectional sync engine.
- Collaborative text has one authoritative representation and protocol; later agent edits must use it too.
- Keep unrelated app/tool bundles off the homescreen's first load.

For P0, produce a runnable workspace, lightweight themed shell, lazy Notes/Recipes entries, typed contracts, build/check scripts, and the runtime/auth compatibility decision. Follow the execution plan for exact deliverables and evidence. Empty app entries are acceptable in P0 only and must be labeled as such.

Run appropriate checks. Never fabricate a deployment, integration result, or iOS test. Report missing credentials/device access as pending evidence while completing independent local work. Do not expose secrets in commands, logs, files, or reports.

Finish with `docs/reviews/P0-implementation.md` using the report template, a concise summary, and reproducible commands. Stop at the P0 review checkpoint. The next phase will be assigned after review.

---

## Prompt for subsequent phases

Implement **[PHASE ID]** from `docs/handoff/execution-plan.md`, following `docs/specs/palladian-platform-v1.md`. Read previous implementation and independent-review reports first. Resolve outstanding findings relevant to this phase. Preserve approved protected contracts. Complete only this phase, run its checks, write `docs/reviews/[PHASE ID]-implementation.md`, and stop at its review checkpoint. Do not treat missing real-device/integration evidence as a pass.

## Prompt to request independent review

Review **[PHASE ID]** of Palladian against `docs/specs/palladian-platform-v1.md` and `docs/handoff/execution-plan.md`. Read the implementer's report, inspect the actual code/diff, and reproduce critical checks. Focus on the phase's protected contracts and acceptance IDs. Report defects by severity with file/line evidence and concrete fixes. Distinguish unverified behavior from demonstrated failure. Write `docs/reviews/[PHASE ID]-review.md` with an explicit acceptance decision. Do not assume passing tests prove correct authorization, renewal, or collaboration semantics.
