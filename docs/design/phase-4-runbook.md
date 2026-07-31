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

The pin is part of the approval hash scope whenever present; changing it after approval voids approval. A framework bug is fixed in the framework repository first, then the product receives a separately reviewed pin-bump change. This is a validation-only bootstrap, not a distribution mechanism: publishing and release lifecycle remain deferred under Backlog B12.

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

## Definition of done (Phase 4 = charter headline)

Production-grade, consumer-ready product shipped end-to-end through Crucible; validation-report.md written; zero un-ratcheted escaped defects; backlog re-groomed with Phase-4 learnings (esp. distribution readiness).
