# Tasks — Phase 2

> **Ratified via P2-00 (2026-07-24)** — tasks below are executable. All "per P2-00-resolved" references point at the inline *Resolved P2-00* passages in `docs/design/phase-2.md`. Format and rules identical to phase-0-1 tasks (test-first; done = named tests pass + committed; one task ≈ one session).

> **Completion ledger (normalized 2026-07-31).** P2-00 through P2-18 are **complete**: the named acceptance coverage is present in the committed Phase 2 implementation, with P2-17's worked-examples suite and P2-18's target-branch-rule proof as the phase anchors. The phase exit is recorded in [PHASES.md](../../PHASES.md). Individual *As-built* notes below provide implementation detail where added during delivery; this ledger supplies the status marker for every task.

**P2-00 · Re-ratification of Phase 2 design** · Tier: Fable / Sol · Depends: P1-16 green
Reads: phase-2.md (whole), architecture.md as frozen by P1, spike-notes, tracer test.
Delivers: amended phase-2.md with all `[P1-DEP]` markers resolved; amended task list below if scope shifted; architecture.md additions for any new cross-phase contracts.
Acceptance: zero `[P1-DEP]` markers remain; PHASES.md status updated.

**P2-01 · Archive & regression collection** · Tier: Opus / Terra · Depends: P2-00
Delivers: `commands/archive.ts`; regression binding collector; lint archived-REQ index.
Acceptance: archiving the tracer change registers its bindings; verify on a second change runs them; bugfix-style binding referencing archived REQ passes lint; unarchived unknown REQ still fails.

**P2-02 · Tier computation module** · Tier: Opus / Terra · Depends: P2-00
Delivers: `tier/` with facts-in/decision-out API; state + status display of facts.
Acceptance: charter tier table cases covered (incl. risk-glob dominance, spec-delta⇒≥standard, diff-cap bump, force-up flag, force-down impossible); deterministic across runs.

**P2-03 · Routing + diff caps in verify** · Tier: Opus / Terra · Depends: P2-02
Delivers: verify report `routing` + cap enforcement; `crucible-route` CI behavior in template.
Acceptance: critical → human routing asserted in template test (per P2-00-resolved mechanics); trivial/standard green → auto path; cap breach → exit 1 naming tier + cap.

**P2-04 · escalate command** · Tier: Opus / Terra · Depends: P2-00
Delivers: `commands/escalate.ts`; escalation.yaml schema; implement refusal while unresolved.
Acceptance: FakeSubstrate implement run that escalates halts; resume refused with hint `crucible amend`; notify dispatch invoked (spy).

**P2-05 · amend command (+ propose --revise & staleness)** · Tier: Opus / Terra (UX ratified in P2-00, design §3) · Depends: P2-04, P1-06
Delivers: `commands/amend.ts`; `--revise`; generation-hash staleness tracking; approval `amendments[]` appending.
Acceptance: escalation resolution end-to-end (pick option → regenerated artifacts diff shown → re-seal → implement resumes); design-edited-after-oracles → approve refuses until revise/confirm; post-amend hash verification passes; direct post-approval edit still voids.

**P2-06 · override command + ratchet issue** · Tier: Opus / Terra · Depends: P2-03
Delivers: `commands/override.ts`; override.yaml; CI forced-human + issue filing.
Acceptance: override present → verify green-with-override flag; routing forced human regardless of tier; issue payload correct (mocked API); missing reason → exit 2.

**P2-07 · Change-type schemas** · Tier: Opus / Terra · Depends: P2-00, P2-01
Delivers: the root `schemas/` workspace (does not exist yet — P2-00 as-built finding) holding the three sibling bundles (`crucible`, `crucible-bugfix`, `crucible-refactor`); type inference + `--type`; refactor lint rules.
Acceptance: refactor with spec delta → exit 3; refactor tracer flows on regression suite alone; type recorded + revalidated like tier.

**P2-08 · Red-on-base / green-on-fix check** · Tier: Opus / Terra · Depends: P2-07
Delivers: bugfix verify check via merge-base worktree run.
Acceptance: fixture bugfix passes; reproduction-passes-on-base → exit 1 "does not reproduce"; reproduction-fails-on-head → normal red; worktree cleanup proven.

**P2-09 · Rubric loader + verdict schema** · Tier: Opus / Terra · Depends: P2-00
Delivers: rubric.yaml zod schema + default rubric file; verdict zod schema; fail-closed evaluator (malformed / fail-no-blocks / unknown-ID).
Acceptance: charter's 12-line default validates; each fail-closed rule has a malformed fixture proving it.

**P2-10 · review command + role prompt** · Tier: Fable / Sol · Depends: P2-09, P1-08
Delivers: `commands/review.ts`; `.crucible/context/review.md`; verify integration (CI always, `--review` local); PR observations output.
Acceptance: FakeSubstrate canned verdicts flow (pass, block-finding, malformed→fail); rubric_hash pinned in verdict; findings render via `why` path format.

**P2-11 · Trajectory indexing + local-verify stamp** · Tier: Opus / Terra · Depends: P2-00
Delivers: transcript indexing in state; `local_verify_ran` surfaced in CI report per config.
Acceptance: stamp true/false paths asserted; absence with require_local_verify → report finding (advise-level, per parked-checks status).

**P2-12 · init** · Tier: Opus / Terra (install surfaces confirmed in P2-00, design §7) · Depends: P2-07, P2-09
Delivers: `commands/init.ts` per design §7.
Acceptance: fresh repo → complete working setup (asserted file-by-file); re-run idempotent (diff-and-confirm, no silent overwrite); gitignore entries present.

**P2-13 · doctor** · Tier: Opus / Terra · Depends: P2-12
Delivers: `commands/doctor.ts` per design §7.
Acceptance: detects tampered schema bundle, stale CI template, out-of-range OpenSpec, ~~bad adapter hash~~ *(deferred → P3-09)*; all fixes offered as diffs; accepts/skips upstream rubric lines without silent merge.
*(As-built P2-13.)* Shipped `commands/doctor.ts` + `doctor.cli.ts` + `openspec-support.ts` with a four-check registry (`CHECKS`): schema-bundle integrity, CI-template currency, OpenSpec version-range, upstream rubric-line offers — checked against the SAME shipped sources `init` installs from (`@crucible/schemas`, `@crucible/ci-templates`, `core/assets/rubric.default.yaml`, and the OpenSpec support window). doctor is read-only until confirmed: every fix (a `current → desired` diff) is routed through the injected `confirmFix` edge; upstream rubric lines are offered one at a time and appended only on an explicit yes (never silently merged). Exit 1 iff a `drift` finding is left unfixed; rubric offers never gate the exit. **The `bad adapter hash` clause was split to P3-09**, not folded in: the adapter lockfile-with-content-hash it would verify is minted by P3-06's pin flow and did not exist in Phase 2 (a can't-yet-run check would violate invariant 3's "no skipped checks pretending to pass"); the `CHECKS` registry is the seam it slots into. Design §7 records the same deferral.

**P2-14 · Approve review surface** · Tier: Opus / Terra (UX ratified P2-14, design §8) · Depends: P2-05
Delivers: rendered approve flow per design §8 incl. critical per-oracle acks; $EDITOR loop.
Acceptance: side-by-side render for tracer bundle; edit→revalidate→regen-test-diff loop; critical tier blocks confirm until all acks; `--yes` still works for tests (non-critical only).

**P2-15 · notify dispatcher** · Tier: Opus / Terra · Depends: P2-04
Delivers: `notify/` with terminal/desktop/webhook/github hooks.
Acceptance: config-driven dispatch on escalation/override/verify events; hook failure logged, never throws to caller (convenience-never-enforcement test).

**P2-16 · crucible why** · Tier: Opus / Terra · Depends: P2-03, P2-10
Delivers: `commands/why.ts` trace across check→oracle→binding→adapter output→rubric finding.
Acceptance: each failure class in the tracer negatives traceable to its source with file paths; unknown id → exit 2 with available ids.
*(As-built P2-16.)* Shipped `commands/why.ts` + `why.cli.ts`. `why <change> <id>` **re-runs the real `verify` core** through capturing wrappers on the injected `resolve`/`run` edges, so one pass yields BOTH the authoritative report (what is red + the exact subject ids) AND the adapter intermediates (each target's resolved `targetFile` + raw `RunResult.location`) that the flattened report drops — then re-parses the bundle for source line numbers and walks the id back to source. Id resolution is **namespaced, first-match**: check name → ORC id → REQ id → rubric line (`R-…`) → sealed relpath; the three P1-16 tracer negatives address as `ORC-…` (oracles check → binding → resolved test file → raw run location, invariant-4 `=skip` provenance), `REQ-…` (traceability check → spec `file:line` → the coverage gap), and the sealed `…/oracles.md` relpath (approval check → recorded vs current sha256, invariant-6 void). Rubric ids trace to the reviewer-law line (criterion + evidence) plus the review finding's `explanation — file:line; fix: remediation` when a review ran (`--review`; else the line alone). `why` is **read-only** (invariant 11 — exit 0 whether the subject is red or green; a pass header reads "not a red source", never claiming an un-run oracle passed); an **unknown id is exit 2** listing every addressable id, and a missing/malformed bundle bubbles verify's exit 2/3. Live adapter edges stay `init`-pinned (P2) exactly like verify's — the injectable core is the tested surface (`why.test.ts`). Design §8 L108 records the same chain.

**P2-17 · Worked-examples integration suite** · Tier: Fable / Sol · Depends: all P2
Delivers: three integration tests mirroring charter worked examples (standard, refactor, critical+escalate+amend+bugfix) on toy fixtures; PHASES.md Phase 2 marked done.
Acceptance: all green in CI with FakeSubstrate; real-substrate runbook updated; these join P1-16 as permanent regression anchors.
*(As-built P2-17.)* Shipped `core/test/worked-examples.test.ts` — one `describe` per charter §Worked Examples flow, all green in CI: **(1) standard feature** → tier `standard`, routing `auto`, reviewer pass; **(2) pure refactor** → type inferred `refactor`, tier `trivial`, correctness carried by the non-empty regression suite, plus the honest-residual negative (a refactor that breaks a PAST promise → `regression` red → verdict fail); **(3) critical path** → risk-glob match ⇒ tier `critical`; `escalate` writes escalation.yaml + notifies, `implement` then REFUSES to resume (exit 2), `amend` regenerates via the propose role + re-seals + clears the escalation, `implement` resumes green, and verify routes `human` (critical never auto-merges); its **follow-up bugfix** segment runs red-on-base/green-on-fix on a REAL two-commit `git worktree`. Realness boundary extends the P1-16 tracer's: ONLY agent sessions are faked (FakeSubstrate); the P1-11 client + built stub adapter, the seal, lint, tier/routing computation, the P2-09 fail-closed verdict evaluator (the reviewer edge runs the real `commands/review` flow), and the worktree merge-base run all execute for real. The three flows are `skipIf(CRUCIBLE_REAL_SUBSTRATE)` — their shared propose→approve→implement→verify spine is the tracer's live-mode job; the runbook (`docs/design/tracer-runbook.md §Worked examples (P2-17)`) documents driving the P2-only surfaces (`escalate`/`amend`/`review`/`override`) manually against a kept scratch. Joins P1-16 (tracer), `bugfix-flow.test.ts` (P2-08) and `change-type-flow.test.ts` (P2-07) as a permanent regression anchor. **This task's completion is the Phase 2 exit criterion** — PHASES.md Phase 2 flipped to done.

**P2-18 · Executable target-branch-rule proof** · Tier: Opus / Terra · Depends: P2-03
Reads: charter §The Target-Branch Rule; phase-0-1.md §9 (P1-15 Settled note); phase-2.md §P2-03 (per P2-00-resolved mechanics).
Delivers: an end-to-end test that exercises the *shipped* `ci-templates/crucible.yml` gate against a change whose PR **loosens a risk glob**; docs updated to fold the now-executable clause back out of the "structural-only" caveat in phase-0-1.md §9. *(Harness resolved P2-18 — **hermetic test-repo**, not `act`; rationale in design phase-2.md §2. Delivered: `core/test/target-branch-rule.test.ts`.)*
Acceptance: a PR that loosens/exempts a glob in its own `crucible.yaml` still fails the verify check because CI evaluated the **target-branch** config (invariant #7 proven behaviorally, not just structurally); the mirror case — the same loosening merged to the target branch first — then passes; verify red → check red still holds. **This is invariant #7's permanent regression anchor** (analogous to P1-16 for the tracer).
Rationale: split out of P1-15 rather than amended into it — in P1 `verify` does not consume enforcement config, so the loosened-glob proof is not reachable until verify reads `--config-from` (P2-03). P1-15 delivered the structural half (target-branch *sourcing* + fail-closed gate, asserted by `ci-templates/src/crucible-template.test.ts`); this task delivers the behavioral half once the config-consumption machinery exists.
