# Crucible V2 — Build Bundle

Everything needed to start building Crucible V2 with Claude Code. Drop the contents of this bundle into the root of a fresh git repo.

## Contents

```
CLAUDE.md                     Build constitution: invariants, session rules, settled decisions.
                              Loaded automatically by Claude Code every session.
PHASES.md                     High-level phase ledger with exit criteria and status.
docs/charter.md               The founding document: full V2 architecture, mechanics, specs,
                              worked examples, V1 comparison, backlog. Source of truth.
docs/design/architecture.md   Cross-phase stable contracts (module map, exit codes, error
                              taxonomy, interface freeze points). The meta-build's TCB doc.
docs/design/phase-0-1.md      Phase 0 (spike/scaffold) + Phase 1 (tracer bullet) design.
docs/tasks/phase-0-1.md       Fine-grained, test-first, tier-tagged work orders (P0-01..P1-16).
```

Phase 2+ design/tasks docs are deliberately absent — they get written only after the prior phase's exit criterion is met (tracer-bullet rule, see PHASES.md).

## Starting the first session

1. `git init`, commit this bundle, open Claude Code in the repo.
2. Set the model per the task's tier tag (P0-01 is Fable-tier).
3. First prompt, roughly:

   > Read CLAUDE.md, then docs/tasks/phase-0-1.md task P0-01 and everything in its Reads field. Restate the task's requirements and your plan, then wait for my approval before executing.

4. Approve the plan (you review artifacts, not code), let it execute, check acceptance criteria, commit.
5. Repeat per task. `/clear` between tasks — continuity lives in these docs, not in conversation history.

## Working rules (short version — full version in CLAUDE.md)

- Test-first: acceptance tests exist and fail before implementation code.
- Done = the task's named tests pass, never an agent's claim.
- Amendment discipline: docs and code change in the same commit when reality disagrees with a design.
- Commit at every green step.
- Fable for judgment-dense tasks, Opus for well-specified implementation — tags are in the tasks file.
