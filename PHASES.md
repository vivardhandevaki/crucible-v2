# PHASES.md — Build Ledger

High-level milestone tracker. Fine-grained work lives in `docs/tasks/phase-*.md`; this file only records phase status and exit criteria. Update the status line when a phase's exit criterion is met.

| Phase | Scope (summary) | Design doc | Tasks file | Exit criterion | Status |
|---|---|---|---|---|---|
| 0 | OpenSpec spike, monorepo scaffold, toy fixture | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P0-01..03) | Spike notes committed; CI green on scaffold; OpenSpec version pinned | ☑ done (spike notes committed; pin `@fission-ai/openspec@1.6.0`; CI green) |
| 1 | Tracer bullet: thin propose → approve → implement → verify → status + CI check, stub adapter | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P1-01..16) | P1-16 tracer integration test green in CI | ☑ done (P1-16 tracer green in CI; re-verified locally at P2-00, 294 tests) |
| 2 | Deepen the loop: full lint, tiers, amend/override/escalate, change types, reviewer + rubric, trajectory capture, notify, why, doctor, approve surface | `design/phase-2.md` (ratified via P2-00, 2026-07-24) | `tasks/phase-2.md` | All three charter worked-example flows executable on toy repo | ◐ in progress (P2-00, P2-02, P2-03, P2-04, P2-05, P2-06, P2-18 done; P2-01, P2-07..17 open) |
| 3 | Real adapter: conformance fixtures (Maven+Gradle) → `java-junit`; stub retired to conformance suite | `design/phase-3.md` **(DRAFT — re-ratify via P3-00 after P2 green)** | `tasks/phase-3.md` **(DRAFT)** | Conformance passes; hello-world Spring Boot change flows end-to-end | ☐ blocked on Phase 2 |
| 4 | Validation project: production-grade Spring Boot product built with Crucible; instrumented metrics; just-in-time Category-A remnants | `design/phase-4-runbook.md` (operating guide; product designs are Crucible artifacts in its own repo) | — | Product shipped; instrument numbers recorded (see charter §Build Plan success criteria) | ☐ blocked on Phase 3 |

**Rules:** Phase 2+ docs exist as DRAFTS for roadmap visibility; each phase begins with a mandatory Fable-tier re-ratification task (P2-00 / P3-00) that resolves the draft's dependency markers against the as-built prior phase — no draft task executes before its gate task completes (tracer-bullet rule, preserved). Deviations from a phase design are amended into the design doc in the same commit (amendment discipline). Model-tier tags in tasks files are respected per CLAUDE.md session rules.
