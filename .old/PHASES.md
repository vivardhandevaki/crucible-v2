# PHASES.md — Build Ledger

High-level milestone tracker. Fine-grained work lives in `docs/tasks/phase-*.md`; this file only records phase status and exit criteria. Update the status line when a phase's exit criterion is met.

| Phase | Scope (summary) | Design doc | Tasks file | Exit criterion | Status |
|---|---|---|---|---|---|
| 0 | OpenSpec spike, monorepo scaffold, toy fixture | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P0-01..03) | Spike notes committed; CI green on scaffold; OpenSpec version pinned | ☐ not started |
| 1 | Tracer bullet: thin propose → approve → implement → verify → status + CI check, stub adapter | `design/phase-0-1.md` | `tasks/phase-0-1.md` (P1-01..16) | P1-16 tracer integration test green in CI | ☐ not started |
| 2 | Deepen the loop: full lint, tiers, amend/override/escalate, change types, reviewer + rubric, trajectory capture, notify, why, doctor, approve surface | `design/phase-2.md` *(write after P1 green)* | `tasks/phase-2.md` *(write after design)* | All three charter worked-example flows executable on toy repo | ☐ blocked on Phase 1 |
| 3 | Real adapter: conformance fixtures (Maven+Gradle) → `java-junit`; stub retired to conformance suite | `design/phase-3.md` *(write after protocol survives P2)* | `tasks/phase-3.md` | Conformance passes; hello-world Spring Boot change flows end-to-end | ☐ blocked on Phase 2 |
| 4 | Validation project: production-grade Spring Boot product built with Crucible; instrumented metrics; just-in-time Category-A remnants | — (product designs are Crucible artifacts in its own repo) | — | Product shipped; instrument numbers recorded (see charter §Build Plan success criteria) | ☐ blocked on Phase 3 |

**Rules:** Phase N+1's design doc is written only after Phase N's exit criterion is met (tracer-bullet rule). Deviations from a phase design are amended into the design doc in the same commit (amendment discipline). Model-tier tags in tasks files are respected per CLAUDE.md session rules.
