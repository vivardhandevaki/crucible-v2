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
- `core/`: deterministic workflow engine and agent substrates.
- `adapters/`: standalone JSON-over-stdin/stdout test adapters.
- `schemas/`, `fixtures/`, `ci-templates/`: shipped workflow assets and executable proofs.

Phase 1 and Phase 2 are complete. Phase 3 is complete through P3-05 and P3-10; P3-06 is next.

## Agent prerequisites

For Codex:

```sh
codex --version
```

Authenticate Codex before running a live Crucible command. New `crucible init` projects select Codex by default.

For Claude Code:

```sh
claude --version
```

Authenticate Claude Code before selecting it. Existing Crucible projects with no explicit provider retain the Claude Code default.

Select the provider in team settings or override it locally:

```yaml
# .crucible/settings.yaml or .crucible/local.yaml
agent:
  provider: codex # codex | claude-code

models:
  propose: optional-provider-model
  implement: optional-provider-model
  review: optional-provider-model
```

An explicit role model is opaque to Crucible and overrides that provider's built-in default.

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
