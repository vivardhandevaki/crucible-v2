# Crucible V2

Crucible is a framework for AI-driven software development where humans approve intent artifacts (specifications and executable oracles), while deterministic machinery verifies that the implementation honors them.

The framework and this repository support both OpenAI Codex and Claude Code.

## Repository guide

- `AGENTS.md`: canonical build constitution for every coding agent.
- `CLAUDE.md`: compatibility bridge directing Claude Code to `AGENTS.md`.
- `PHASES.md`: high-level milestone ledger.
- `docs/charter.md`: founding architecture and source of truth.
- `docs/design/`: stable contracts, phase designs, and the real-substrate runbook.
- `docs/tasks/`: test-first, model-tiered work orders.
- `core/`: deterministic workflow engine and generated agent-skill definitions.
- `adapters/`: standalone JSON-over-stdin/stdout test adapters.
- `schemas/`, `fixtures/`, `ci-templates/`: shipped workflow assets and executable proofs.

Phases 1–3 are complete. Phase 4 validation was halted after exposing an
architectural failure; Phase 4R is the active framework reset. See
`docs/design/phase-4r-reset.md` and `docs/tasks/phase-4r.md`.

## Agent prerequisites

For Codex:

```sh
codex --version
```

Open Codex in the initialized project and use the generated Crucible skills.
Crucible's CLI does not authenticate or launch Codex.

For Claude Code:

```sh
claude --version
```

Open Claude Code in the initialized project and use the generated Crucible
skills/commands. Crucible's CLI does not launch Claude Code.

During `crucible init`, select which agent-tool surfaces to install. Tool
selection is convenience and cannot change validation or merge decisions:

```yaml
# .crucible/settings.yaml
agent_tools:
  - codex
  - claude-code
```

## Working with an agent

Start Codex, Claude Code, or another coding agent in the repository and ask it to read `AGENTS.md`, the current task, and every file named by the task's `Reads:` field. The canonical workflow is:

1. Restate the requirements and plan.
2. Write the task's acceptance tests first.
3. Implement until the named deterministic checks pass.
4. Update design documentation in the same change when implementation reveals a contract amendment.

Task recommendations are paired by role:

- Fable / Sol: design-heavy or judgment-heavy work.
- Opus / Terra: well-specified implementation work.

The full rules and invariants live in `AGENTS.md`. Conversation history is convenience; durable continuity lives in the repository.
