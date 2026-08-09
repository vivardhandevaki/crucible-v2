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

**Decision amended by P4-10, ratified 2026-08-03:** implement P4-08 and P4-10 as one cluster. Install a hub plus command-specific skills during `init`. Propose/revise and implement use P4-10's session-native CLI handoffs; every other skill remains a thin pinned-CLI wrapper. The earlier all-roles-fresh clause applies to command-invoked roles, not the separately governed session-native mode.

Acceptance:

- every skill is a thin guided wrapper around the real pinned Crucible CLI; it cannot bypass artifact validation, approval hashes, target-branch enforcement, or command preconditions;
- a hub skill reports the current governed state and recommends only valid next commands;
- all command-invoked roles remain fresh-context invocations; session-native propose/revise and implement author only inside the real CLI handoff path;
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

**Decision ratified 2026-08-03; delivered 2026-08-05:** the design gate is satisfied by charter + architecture §10 + runbook amendments. P4-10 absorbs P4-08 as one implementation cluster. Initial session-native scope is propose/create, pre-approval revise, and implement; review, amend, and approve-time regeneration remain fresh child roles. Skills call a validated gitignored local launcher bound to `.crucible/framework.lock.json`; CI and enforcement are unchanged. The cluster shipped in PR #28; the generated-launcher root correction shipped in PR #29. Notes dogfooding then exposed the pre-approval oracle-test handoff gap tracked as P4-11 below.

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

**P4-11 · Session-native oracle-test handoff and task boundary** · Tier: Fable / Sol (adapter/session contract amendment) + Opus / Terra (implementation) · Trigger: Notes dogfooding reached `oracles.md`, but the CLI could neither authorize the missing bound test files nor prevent packaged OpenSpec from offering `tasks.md` before approval

Reads: charter §The Workflow, §The Approve Session, §Traceability Lint — Mechanics, §Bindings & the Adapter Protocol, §Static Context Surfaces; architecture.md §7 and §10; design/phase-3.md §P3-03 and §P3-06; design/phase-4-runbook.md §Session-native local workflow; AGENTS.md invariants 1–6 and 10–12; issue ledger P4-010.

Delivers: an adapter-grounded pre-approval oracle-test stage for session-native propose, plus one execution-mode-independent gate that keeps `tasks.md` post-approval.

**Decision ratified 2026-08-06:** amend the existing `resolve` result rather than add a runner-specific core parser or a third required adapter verb. `found` strictly carries existing `targetFile`; `missing` may carry a deterministic safe `candidateFile`. Candidates authorize only exact pre-approval test writes and remain unresolved until ordinary collection succeeds. Session propose filters OpenSpec's apply-time task instruction, migrates P4-10 checkpoints by artifact re-derivation, and advances `artifacts → oracle-tests → ready`. Both headless propose and approve reject any pre-approval `tasks.md`.

Acceptance (write these tests red before production changes):

- `core/src/adapters/client.test.ts` rejects every malformed resolve union (missing `targetFile` on `found`, `candidateFile` on `found`, `targetFile` on `missing`, unknown fields) while accepting a contained candidate on `missing`;
- `adapters/java-junit/src/source-file.test.ts`, `maven.test.ts`, and `gradle.test.ts` prove candidate paths come only from evaluated test roots, reuse an existing class source for a missing method, select a stable configured root for a missing class, and omit candidates for malformed/unsupported/outside-project targets;
- `core/src/session/session.test.ts` proves OpenSpec `tasks.md` is never returned pre-approval, exact candidate paths are grouped into oracle-test handoffs, all-found targets advance to ready, unlocatable targets fail closed with revision recovery, P4-10 checkpoints migrate, and finish cannot turn a candidate into green;
- command/bundle tests prove both headless `propose` and `approve` reject a pre-approval `tasks.md`, while implement still creates and consumes it only after a valid seal;
- full typecheck, lint, adapter suites, core suites, and build pass; the Notes `create-note` checkpoint resumes through bound-test creation without deleting or recreating its reviewed bundle.

**P4-12 · Java/JUnit dependency-backed resolver classpath** · Tier: Fable / Sol (TCB/build-model design) + Opus / Terra (implementation) · Trigger: Notes dogfooding compiled its Spring MockMvc oracle tests, but resolver discovery loaded only `target/classes` + `target/test-classes` and failed with `NoClassDefFoundError: org/springframework/test/web/servlet/RequestBuilder`

Reads: charter §Bindings & the Adapter Protocol, §Adapters Are Part of the Trusted Computing Base, and §First Reference Adapter — `java-junit`; architecture.md §7 and §9; design/phase-3.md §1–3; design/phase-4-runbook.md §Session-native local workflow and §Escalation of framework bugs; AGENTS.md invariants 1–6 and 12 plus the routing/test-first/scope rules; issue ledger P4-011.

Delivers: build-tool-evaluated Maven and Gradle test discovery classpaths for the existing Java/JUnit Launcher helper, with dependency-backed class loading, no test execution, and strict failure on unavailable or malformed classpath state. No core wire, session lifecycle, target syntax, run-path, module-routing, or product-test change is in scope.

**Decision ratified 2026-08-06:** retain `resolve` and the bundled Launcher helper; do not add a core parser, another adapter verb, a test execution fallback, or framework-specific Spring logic. Maven runs `test-compile`, then an adapter-pinned fully qualified `maven-dependency-plugin:build-classpath` goal (initial version `3.11.0`) into a fresh private file; discovery receives `testOutputDirectory` + `outputDirectory` from Maven's effective model followed by the emitted test-scope dependencies in Maven order. Gradle runs `testClasses`, then a private init-script task writes the configured root `Test` task's exact classpath as JSON; discovery preserves Gradle order. Both paths may resolve dependencies but never invoke tests. Any tool/model/output/dependency/linkage failure aborts the adapter; only an actually absent target class is `missing`, and there is no partial or compiled-output-only fallback.

**Delivered 2026-08-06 (`76a0995`):** Maven passes effective `testOutputDirectory` + `outputDirectory` and the fixed dependency-plugin's ordered test-scope output; Gradle serializes the configured root `Test.classpath` through a private init script. The Launcher helper now treats linkage failures as adapter errors rather than `missing`. Focused regressions, resolver no-execution canaries, package byte stability, root lint, full tests/conformance, and workspace build are green.

Acceptance (write these tests red before production changes):

- add a Maven Spring Boot/MockMvc discovery regression which reproduces the Notes linkage failure with the old two-directory classpath, then proves `resolveMaven` returns the exact target as `found` + grounded `targetFile` with dependencies present;
- add the Gradle twin using a dependency-backed JUnit integration class and a deliberately customized `Test.classpath`, proving `resolveGradle` consumes the evaluated task classpath rather than hard-coded build directories;
- retain and extend the resolve side-effect canary for both tools: compilation, dependency resolution, and model extraction may occur, but no test body runs and no Maven `test`/Gradle `test` invocation is made;
- focused classpath tests prove entry order and first-occurrence de-duplication are stable; Maven uses evaluated output directories plus pinned-plugin test-scope output, while Gradle accepts only the private JSON array from the root `Test` task;
- malformed/failure coverage rejects build-tool spawn and non-zero exits, missing/unreadable output files, malformed JSON or delimiter output, empty/non-string entries, nonexistent Maven dependency entries, Gradle dependency-resolution failure, an absent/wrong-type Gradle `test` task, helper non-zero/bad JSON, and linkage failure for an existing target; none may degrade to `missing` or produce a candidate;
- existing genuinely absent targets still return `missing` (and P4-11 candidates where safe), parameterized/dynamic targets remain unsupported→`missing`, found-target grounding remains exact, input ordering remains stable, and Maven/Gradle conformance stays green;
- rebuild the packaged adapter twice and prove byte-identical output, then pass adapter typecheck/lint/tests, full conformance, core regression suites, and root build. Product validation after merge/pin reruns the preserved Notes checkpoint to `ready`; approval and implementation remain explicitly out of P4-12.
