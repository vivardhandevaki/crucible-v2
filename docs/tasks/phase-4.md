# Tasks — Phase 4

> **Status: pending validation pulls.** Phase 4 is the validation project rather
> than a pre-designed framework build phase. Add tasks here only when product
> evidence exposes a real framework need; execute each under the normal
> design-then-implementation, test-first discipline.

**P4-07 · Dedicated framework-pin update command** · Tier: Fable / Sol (design) + Opus / Terra (implementation) · Trigger: framework version must change in a governed product

Reads: charter §Configuration & Reviewer Law, §Editing Artifacts; architecture.md §2, §6–8; design/phase-4-runbook.md §Validation bootstrap and §Escalation of framework bugs; issue ledger P4-004.

Delivers: a dedicated command, tentatively `crucible framework update <owner/repository@40-character-sha>`, that updates a product's validation framework pin without re-running the broader `init` installation flow.

Acceptance:

- accepts only the existing strict immutable GitHub source-pin grammar and fails closed on malformed input;
- changes only `.crucible/framework.lock.json`, shows the exact before/after diff, and never writes without explicit confirmation (with an explicit non-interactive opt-in if provided);
- protects approval semantics: it detects and handles any unarchived approved bundle whose seal includes the framework pin according to the ratified design, rather than silently voiding approval;
- documents the two-step rollout: merge the product pin-bump PR under the current target-branch harness, then let subsequent product PRs run the new pinned harness;
- has coverage for malformed pins, declined confirmation, pin-only writes, and approved-bundle edge cases.

**P4-08 · Agent-native Crucible workflow skills** · Tier: Fable / Sol (cross-substrate contract) + Opus / Terra (installation and tests) · Trigger: agent sessions need to drive the complete governed workflow directly

Reads: charter §The Workflow, §Loop Mechanics, §Preconditions, §Configuration & Reviewer Law; architecture.md §1, §6–8; design/phase-4-runbook.md §Validation bootstrap; AGENTS.md invariants 1–5 and 9–11.

Delivers: init-managed, substrate-appropriate agent skills/commands for Codex and Claude Code, covering status/why and the full workflow: propose, approve, implement, verify, review, amend, escalate, override, and archive.

Acceptance:

- every skill is a thin guided wrapper around the real pinned Crucible CLI; it cannot bypass artifact validation, approval hashes, target-branch enforcement, or command preconditions;
- a hub skill reports the current governed state and recommends only valid next commands;
- all command roles remain fresh-context invocations; interactive agent guidance never authors artifacts outside the real command path;
- init installs and updates the managed skill surfaces idempotently while preserving human-owned agent instructions;
