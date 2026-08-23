# PHASES.md — Build Ledger

High-level milestone tracker. Fine-grained work lives in `docs/tasks/phase-*.md`; this file only records phase status and exit criteria. Update the status line when a phase's exit criterion is met.

| Phase | Scope (summary) | Design doc | Tasks file | Exit criterion | Status |
|---|---|---|---|---|---|
| 0 | OpenSpec spike, monorepo scaffold, toy fixture | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P0-01..03) | Spike notes committed; CI green on scaffold; OpenSpec version pinned | ☑ done (spike notes committed; pin `@fission-ai/openspec@1.6.0`; CI green) |
| 1 | Tracer bullet: thin propose → approve → implement → verify → status + CI check, stub adapter | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P1-01..16) | P1-16 tracer integration test green in CI | ☑ done (P1-16 tracer green in CI; re-verified locally at P2-00, 294 tests) |
| 2 | Deepen the loop: full lint, tiers, amend/override/escalate, change types, reviewer + rubric, trajectory capture, notify, why, doctor, approve surface | `design/phase-2.md` (ratified via P2-00, 2026-07-24) | `tasks/phase-2.md` | All three charter worked-example flows executable on toy repo | ☑ done (P2-00..18 complete; P2-17 worked-examples suite green in CI — standard/refactor/critical+escalate+amend+bugfix on toy-repo, FakeSubstrate + real adapter/git/seal/reviewer) |
| 3 | Real adapter: conformance fixtures (Maven+Gradle) → `java-junit`; stub retired to conformance suite | `design/phase-3.md` (ratified via P3-00, 2026-07-29) | `tasks/phase-3.md` | Conformance passes; hello-world Spring Boot change flows end-to-end | ☑ done (P3-08 Spring loop + CI and negative paths green; P3-09 doctor hash-repair UX complete; P3-10 Codex compatibility and JVM isolation green) |
| 4 | Consumer validation and reactive hardening experiment | `design/phase-4-runbook.md` (historical operating guide) | archived at `p4-experimental-final-2026-08-24` | One ordinary generic and Spring consumer lifecycle release-qualified | ⛔ halted (2026-08-24) — validation exposed architectural failure; rollout frozen and experimental state preserved |
| 4R | Framework reset: OpenSpec-like skills, terminal approval, deterministic verify, pre-PR archive, trusted CI | `design/phase-4r-reset.md` (ratified 2026-08-24) | `tasks/phase-4r.md` (P4R-00..14) | Generic + Spring/JUnit disposable consumers and manual Codex UX flow green end-to-end | ◐ active — P4R-00/01 foundation established |
| 5 | Fresh consumer validation on the reset framework | — | — | New production consumer shipped with recorded UX/reliability evidence | ⏸ blocked on Phase 4R exit |

**Rules:** Phase 2+ docs begin behind an explicit design ratification gate. Phase
4 is preserved as a failed validation experiment, not silently relabeled done.
Phase 4R tasks execute only against the ratified reset design; deviations amend
that design in the same commit. Model-tier tags in task files are respected per
AGENTS.md session rules.
