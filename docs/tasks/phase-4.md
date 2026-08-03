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
- tests prove each installed surface resolves the pinned framework CLI and handles precondition failures actionably on both supported substrates.
- a simple skill wrapper is not a P4-09 sandbox fix: if an in-session authoring path is later proposed, it requires its own ratified lifecycle and explicit amendment to the fresh-context contract.

**P4-09 · Codex nested-sandbox compatibility** · Tier: Fable / Sol (security/contract design) + Opus / Terra (implementation) · Trigger: a Codex role session cannot run under the default nested workspace sandbox

Reads: charter §Configuration & Reviewer Law, §The Workflow, §Loop Mechanics; architecture.md §6; design/phase-3.md §P3-10; AGENTS.md invariants 2, 3, 7, 10, and 11; issue ledger P4-007.

Delivers: a ratified, local-only configuration path for selecting Codex's child-process sandbox mode when the default `workspace-write` mode is incompatible with the host's nested sandbox.

**Decision ratified 2026-08-02:** retain `workspace-write` as the default and permit `danger-full-access` only as an explicit operator opt-in in gitignored `.crucible/local.yaml`; do not silently fall back or change CI behavior.

Acceptance:

- default invocation remains isolated `workspace-write` exactly as today;
- the only alternate mode is a strict, documented local-only `danger-full-access` opt-in; malformed or unsupported values fail closed;
- a failed `workspace-write` launch never automatically broadens permissions; its error identifies the local opt-in and its security trade-off;
- the setting remains convenience-only: it is ignored by enforcement/CI and cannot alter a merge decision;
- agent artifact judging remains unchanged: an agent failure still produces no trusted success and the bundle gate fails closed;
- tests cover argument construction for both modes, local-only placement, invalid config, and no-fallback behavior.

**P4-10 · Interactive-session authoring lifecycle** · Tier: Fable / Sol (lifecycle and trust-boundary design) + Opus / Terra (implementation) · Trigger: a governed local role session cannot author artifacts because a nested agent sandbox is unavailable or inappropriate for the operator's trust boundary

Reads: charter §The Workflow, §Loop Mechanics, §Static Context Surfaces, §Configuration & Reviewer Law; architecture.md §1, §6, §8–9; design/phase-3.md §P3-10; design/phase-4-runbook.md §Validation bootstrap and §Escalation of framework bugs; P4-08 and P4-09 above; AGENTS.md invariants 1–5 and 7–12; issue ledger P4-008.

Delivers: a ratified lifecycle for managed Codex and Claude Code skills that lets an already-active interactive agent session author local `propose` and `implement` work directly, without spawning a second authoring-agent process, while the pinned Crucible CLI remains the sole authority for scaffolding, validation, approval, preconditions, and verification.

**Design gate (Fable / Sol — must be ratified before implementation):**

- amend the fresh-context contract explicitly: interactive authoring is a separate local execution mode, not an `AgentSubstrate` role invocation; define its scope, provenance/audit treatment, and failure semantics;
- define the deterministic CLI handoff lifecycle, including exact preflight/scaffold, artifact-validation, retry/revise, and precondition failures; a skill must not infer a valid next state or treat conversation history as authority;
- preserve every enforcement invariant: artifact validation, approval hashes and post-approval immutability, tier computation, target-branch CI evaluation, and fail-closed missing/malformed artifacts;
- define the role matrix. The starting hypothesis is session-native `propose` and `implement`, with adversarial `review` retained as an independent fresh-context invocation until separately ratified;
- define the local trust boundary plainly: interactive session permissions belong to the selected agent surface, are never selected by enforcement config, and cannot alter a merge decision;
- decide whether P4-08 is amended into the managed-skill installation surface for this lifecycle or remains a distinct thin-wrapper task.

**Implementation boundary (only after the design gate):**

- init installs idempotent, substrate-appropriate managed skills while preserving human-owned instructions;
- a session-native authoring skill may write only through the ratified lifecycle and must not launch `codex exec` / `claude -p` to create the same artifacts;
- headless `AgentSubstrate` authoring remains an optional automation path; CI behavior does not change.

Acceptance:

- deterministic tests prove the complete session-native propose and implement handoffs reject missing/invalid prior artifacts, interrupted sessions, malformed bundles, and unresolved bindings without trusting an agent message or session result;
- a valid interactive proposal is indistinguishable to `approve`, `implement`, `verify`, archive, and CI from an equivalent valid headless proposal; seals and oracle immutability remain identical;
- tests prove the installed Codex and Claude Code surfaces invoke the pinned project CLI, preserve human-owned instruction bytes, and never recursively launch a child authoring session;
- the hub surface reports only deterministically valid next lifecycle actions and directs all enforcement decisions to the CLI;
- the reviewer remains independent in the initial release, and any later session-native review path requires a separate ratified amendment;
- no local skill, session setting, transcript, or state cache can alter tiering, approval validity, CI configuration selection, or merge routing;
- documentation explains the permission trade-off and failure recovery, including how a partially scaffolded pre-approval change is resumed or revised;
- coverage includes malformed skill metadata, missing pinned CLI, local-session interruption, partial artifacts, retry/revise behavior, and no-regression coverage for the existing headless path.
