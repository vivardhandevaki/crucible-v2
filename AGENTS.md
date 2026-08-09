# AGENTS.md — Crucible Build Constitution

Crucible is a framework for AI-driven software development where humans approve **artifacts** (specs + oracles), not code. Its job: shrink the trusted computing base from "all the code" to "the specs, oracles, and harness" — and concentrate human attention exclusively there.

**Source of truth:** `docs/charter.md`. Stable cross-phase contracts: `docs/design/architecture.md`. Current phase design: `docs/design/phase-*.md`. Work items: `docs/tasks/phase-*.md`.

## Build decisions (settled — do not relitigate in-session)

- Language: **TypeScript/Node**, strict mode. Monorepo: `core/`, `schemas/`, `adapters/stub/`, `adapters/java-junit/`, `fixtures/`, `ci-templates/`, `docs/`.
- Agent execution substrates: **OpenAI Codex** and **Claude Code**, isolated behind the internal `AgentSubstrate` interface and selected by `.crucible/settings.yaml`.
- Adapters are separate executables speaking JSON over stdin/stdout. Framework core never imports a test framework.
- Built on OpenSpec's artifact format via a custom schema bundle; Crucible is a layer, not a fork.

## Invariants (violating any of these is a bug, regardless of tests passing)

1. **Artifacts are truth.** state.yaml is a derived cache/audit trail; nothing reads it to make an enforcement decision.
2. **Agent self-report is worth zero.** "Done" = artifact exists and validates / named tests pass. Never trust an agent's claim of completion — including your own.
3. **Fail-closed everywhere.** Malformed JSON, unparseable artifacts, unresolvable bindings, missing preconditions → failure, never a warning or a skip.
4. **`skip` = fail for oracle targets.** A skipped judge is a fail-closed event.
5. **Preconditions gate every command.** Each command refuses to run unless the prior stage's artifact exists and validates, and says exactly what to run instead.
6. **Hashes seal.** approval.yaml stores sha256 of every bundle file + bound test file; any mismatch voids approval. Post-approval, sealed oracle/harness inputs are immutable to implement. An explicitly specified enforcement-config edit requires a sealed critical floor and remains subject to target-branch evaluation.
7. **Enforcement config is read from the target branch in CI** — never from the PR branch. Convenience config (settings.yaml, local.yaml) never affects enforcement.
8. **Tiers are computed, never declared.** Force up allowed; force down impossible. Risk-glob match always dominates.
9. **The reviewer blocks only on enumerated rubric lines.** Findings citing unknown rubric IDs → fail (the reviewer may not invent rules). Everything else → observations.
10. **Explicit context per role.** Command-invoked agents start with fresh context: role prompt from `.crucible/context/` + the artifact bundle. The separately ratified session-native mode may let an already-active interactive session author propose/revise and implement work only through CLI-minted handoffs; it is not an `AgentSubstrate` invocation, and its conversation, checkpoint, or self-report is never enforcement input.
11. **Convenience is never enforcement.** Notify hooks, agent shortcuts, status displays can fail without unblocking or blocking anything.
12. **Deterministic core.** Everything except the agent calls (propose/implement/review) must be reproducible: same inputs → same outputs, no wall-clock or randomness in decisions.

## Session rules

- **Routing rule:** before implementing any component, read the charter/design sections named in the task's `Reads:` field and restate the requirements in your plan. If the task and charter conflict, stop and say so — do not pick silently.
- **Test-first rule:** every task's acceptance tests are written and failing before implementation code. Done = those named tests pass. Correctness-critical modules (hashing, oracle/spec parsing, traceability lint, tier computation, verdict parsing, adapter client) require thorough coverage including malformed-input cases — they are the TCB of every future Crucible project.
- **Amendment discipline:** if implementation reveals a design/charter decision is wrong, update the relevant doc **in the same commit** as the code change, with a one-line rationale. Docs never silently drift from code.
- **Commit at every green step.** Small commits; any session must be safely abandonable.
- **Scope discipline:** one task (or a declared small cluster) per session. Do not refactor beyond the task's `Delivers:` without flagging it.
- **Model tiers:** tasks pair Claude and Codex recommendations. Fable / Sol means design- or judgment-heavy work; Opus / Terra means well-specified implementation. If an implementation-tier session finds itself making an architectural decision, stop and flag it for a design pass instead.
