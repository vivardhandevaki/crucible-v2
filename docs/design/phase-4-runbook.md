# Phase 4 — Validation Project Runbook

Phase 4 has **no framework design doc by decision** (PHASES.md): the product's designs are Crucible artifacts in the product's own repo. This runbook covers only the framework-side operation: kickoff, instrumentation, and how remaining backlog items get pulled in.

## Kickoff checklist (product repo)

1. `crucible init` — pin java-junit, accept defaults, then **edit risk globs deliberately** for the product's real risk surface (payments/auth/migrations/etc. — don't ship defaults unexamined).
2. Install CI template (JDK + Testcontainers variant); confirm branch protection: verify + route as required checks; auto-merge enabled.
3. Commit the initial spec baseline (even if near-empty): the archive grows from here.
4. Configure settings.yaml models per charter routing (strongest for propose); local.yaml notify hooks.
5. First three changes deliberately span the tiers: one trivial (repo chore), one standard feature, one critical-path feature — shakes out routing, the approve surface, and escalation early, when stakes are low.

## Validation bootstrap (before public distribution)

Phase 4 deliberately validates Crucible before a public npm/binary release exists. Run `crucible init` from a committed Crucible GitHub checkout (or pass `--framework-source owner/repository@<40-character-lowercase-sha>`). It writes `.crucible/framework.lock.json`, a strict source pin. The shipped CI workflow reads both that pin and `crucible.yaml` from the target branch, checks out the exact commit into a separate directory, builds it with `npm ci && npm run build`, and executes that built CLI. A PR therefore cannot select the harness that judges itself.


The built CLI executes under plain Node. Every workspace package statically reachable from it must export built JavaScript rather than TypeScript source; missing build output is a fail-closed framework error, never a reason to introduce a TypeScript loader in the consumer workflow.

The framework packages and invokes its exact pinned OpenSpec runtime itself. A consumer repository, including a Java/Spring Boot project, does not need a `package.json`, `npm init`, or a separate OpenSpec installation to use `propose` or `archive`.
The pin is part of the approval hash scope whenever present; changing it after approval voids approval. A framework bug is fixed in the framework repository first, then the product receives a separately reviewed pin-bump change. This is a validation-only bootstrap, not a distribution mechanism: publishing and release lifecycle remain deferred under Backlog B12.

## Session-native local workflow (P4-08 + P4-10)

`crucible init` installs a `$crucible`/`/crucible` hub and command-specific Codex/Claude skills. The hub never guesses from conversation history: it asks the pinned local launcher for artifact-derived status and shows only the returned actions. Propose/revise and implement run in the already-active interactive session through `crucible session` handoffs; review and amend remain fresh child roles. The propose skill uses Crucible's packaged OpenSpec primitives through the CLI, never `/opsx:propose` or a global `openspec`.

The operator chooses the interactive agent surface and its permissions before starting Crucible. Those permissions are local and advisory; Crucible never broadens them, and P4-09's `danger-full-access` remains a separate explicit opt-in rather than a fallback. CI still uses the target branch's config and source pin, so neither a skill, launcher, session checkpoint, transcript, nor `state.yaml` can change what merges.

Recovery is always CLI-led:

- interrupted/partially scaffolded proposal: invoke the propose skill again; `session resume` replays the persisted explicit intent, migrates a legacy P4-10 authoring checkpoint if necessary, and derives the next artifact or oracle-test instruction;
- after `oracles.md`: keep invoking the propose skill while the CLI returns exact adapter-grounded bound-test paths; `tasks.md` is never authored before approval, even if raw OpenSpec status considers it ready;
- dependency-backed JVM oracle tests: `resolve` compiles and asks Maven/Gradle for the evaluated test execution classpath, but does not run tests. Dependency/model/tool/linkage failure is a framework-side adapter failure, not a missing target and not a new oracle-test handoff; stop and use the framework-bug escalation below rather than editing the product test to evade class loading;
- red or malformed proposal: fix only the paths named by the handoff/report, then retry `session propose finish`; unresolved bindings remain red, and a target the adapter cannot map safely must be corrected through the exact `propose revise` command reported by the CLI;
- pre-approval intent change: use session-native `propose revise`; an approval already present requires ordinary `amend`;
- interrupted implementation: invoke the implement skill again; the approval-bound checkpoint returns either the tasks or implementation stage;
- missing/malformed/stale checkpoint or missing pinned launcher: stop on the CLI's exit 2/3 teaching error and run the named restart or `init` command—never infer a stage or fall back to an ambient executable.

## Instrumentation (success criteria — record from day one)

Source of numbers: state.yaml events + approval.yaml timestamps + PR/check metadata. Until a `crucible metrics` command exists (build it just-in-time if manual collection annoys — it's a legitimate Phase 4 framework task), keep `docs/metrics.md` in the product repo, one row per merged change:

| change | tier | type | gate minutes | escalations (n, resolution mins) | amends | verify local latency | CI latency | routing | override? | escaped defects (later) |

Plus running counters: auto-merge rate, override count (target ≈ 0), ratchet commits (each escaped defect must produce one — bugfix type enforces it).

**At project end:** write `docs/validation-report.md` — the numbers vs. the charter's instruments, plus qualitative DX notes (where the gate felt heavy, where tasks were wrongly sized, which rubric lines fired, which never did). This is the evidence for "Crucible delivers," and the input for deciding distribution (backlog B12).

## Just-in-time backlog pulls (Category A → framework tasks during Phase 4)

Pull an item **only when the product first needs it**, as a normal framework task with design-then-implement discipline:

- A5 mutation/PIT — when the first critical-tier change merges (blocking mutation is defined for critical tier; until PIT lands, capability negotiation must loudly report "mutation unavailable" and force human review on critical — verify this degradation actually fires).
- A6 stacked changes — first legitimately >400-line change.
- A7 audit digest — once auto-merges accumulate (start manual: weekly review of the 10% sample from state records).
- A9 override automation polish — first real override.
- Remaining A items (capability taxonomy finalization, approve-surface refinements) — as friction reveals priority.

## Escalation of framework bugs

A framework bug found mid-product is fixed in the framework repo under its normal discipline (test-first, amendment of design docs), pinned version bumped in the product. Never patch around the framework inside the product — that's exactly the drift Crucible exists to prevent.

For P4-12 specifically, leave the product proposal and session checkpoint in place while the framework's Java/JUnit classpath defect is fixed. After the framework fix is merged and the product receives a separately reviewed pin bump, rerun `session propose next`; ordinary resolver discovery must return every bound target as `found` before the checkpoint may become `ready`. Do not approve, implement, or replace a dependency-backed integration test with a weaker test while resolution is unavailable.

For P4-13 specifically, leave the product implementation and PR in place while the built-CLI package-export defect is fixed. Do not edit a consumer workflow to add a TypeScript loader or bypass target-branch enforcement. After the framework fix is merged and the product receives a separately reviewed pin bump, re-run the existing PR's CI; the same pinned built CLI must reach ordinary verification under Node 20.
## Definition of done (Phase 4 = charter headline)

Production-grade, consumer-ready product shipped end-to-end through Crucible; validation-report.md written; zero un-ratcheted escaped defects; backlog re-groomed with Phase-4 learnings (esp. distribution readiness).
