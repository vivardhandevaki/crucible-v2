# Tasks — Phase 0 + Phase 1

Format: each task is one focused session. **Done = the named acceptance tests pass + committed.** Tests are written failing before implementation (CLAUDE.md test-first rule). `Reads:` is the session's required context. Tier: Fable = design/judgment-heavy; Opus = well-specified implementation.

---

## Phase 0

**P0-01 · OpenSpec spike** · Tier: Fable · Depends: —
Reads: charter §OpenSpec Integration Mechanics; phase-0-1.md §Phase 0.
Delivers: `docs/design/spike-notes.md`; pinned OpenSpec version range; charter amendments if assumptions were wrong.
Acceptance: a custom schema bundle installed and exercised end-to-end in a scratch repo; notes answer every question listed in phase-0-1.md §Phase 0 item 1.

**P0-02 · Monorepo scaffold** · Tier: Opus · Depends: P0-01
Reads: architecture.md §1, §9; CLAUDE.md build decisions.
Delivers: npm workspaces (`core`, `adapters/stub`, `fixtures`, `ci-templates`), TS strict, vitest, lint/format, GitHub Actions running tests.
Acceptance: `npm test` green locally and in CI; a placeholder test per workspace; layering lint placeholder documented.

**P0-03 · Toy fixture repo** · Tier: Opus · Depends: P0-02
Reads: phase-0-1.md §7, §10.
Delivers: `fixtures/toy-repo/` with `tests.json`, a pre-written valid change bundle, and one deliberately-invalid bundle (for parser tests).
Acceptance: fixture loads in a smoke test; invalid bundle documented with its expected error codes.

---

## Phase 1

**P1-01 · CLI skeleton & error runner** · Tier: Opus · Depends: P0-02
Reads: architecture.md §2–3; phase-0-1.md §1.
Delivers: `cli/` + shared runner; `CrucibleError`; command registration for all P1 verbs (stubbed).
Acceptance: unknown command → help + exit 2 with hint; thrown CrucibleError maps to declared exit codes; unexpected exceptions → exit 4 with stack to stderr; `--json` plumbing exists. Tests cover each exit-code path.

**P1-02 · Config loaders** · Tier: Opus · Depends: P1-01
Reads: charter §Configuration & Reviewer Law; phase-0-1.md §2.
Delivers: `config/enforcement.ts`, `config/convenience.ts`, zod schemas, `--config-from` support.
Acceptance: valid fixtures load; unknown enforcement key → exit 3; local>settings merge order proven; enforcement module has zero imports from convenience (test via dependency check).

**P1-03 · Oracle parser** · Tier: Opus · Depends: P1-01
Reads: charter §Oracle File Syntax; phase-0-1.md §3.
Delivers: `artifacts/oracles.ts`.
Acceptance: parses the valid fixture into typed oracles; each grammar violation in the invalid fixture (bad ID, missing fence, two fences, bad kind, no requirement) → exit 3 naming heading+line; `targets[]` list form supported.

**P1-04 · Spec-delta REQ extractor** · Tier: Opus · Depends: P1-01
Reads: charter §Requirement IDs; phase-0-1.md §3.
Delivers: `artifacts/spec-delta.ts`.
Acceptance: extracts ordered REQ IDs from fixture deltas; malformed bracket ID → exit 3; duplicate REQ ID → exit 3.

**P1-05 · Traceability lint v0** · Tier: Opus · Depends: P1-03, P1-04
Reads: charter §Traceability Lint — Mechanics; phase-0-1.md §8.
Delivers: `lint/` with injectable `resolve` (no adapter dependency).
Acceptance: green on valid fixture; REQ-without-oracle, orphan-oracle, unresolved-binding each produce a finding naming the exact ID; findings machine-readable.

**P1-06 · Hash module & approval.yaml** · Tier: Opus · Depends: P1-03
Reads: charter §Approval, Amend, Override; phase-0-1.md §3–4.
Delivers: `hash/`, `artifacts/approval.ts`.
Acceptance: sealing the fixture bundle is byte-stable across runs; single-byte edit to any covered file → void with that file listed; missing covered file → void; amendments array round-trips.

**P1-07 · approve command** · Tier: Opus · Depends: P1-05, P1-06
Reads: phase-0-1.md §6.
Delivers: `commands/approve.ts` (terminal render + confirm + `--yes`).
Acceptance: refuses invalid bundle / red lint (exit 2 with hint); writes correct approval.yaml on confirm; re-approve on unchanged bundle idempotent; state event appended.

**P1-08 · AgentSubstrate + ClaudeCode + Fake** · Tier: Fable (interface freeze) then Opus (impl) · Depends: P1-01
Reads: architecture.md §6; phase-0-1.md §5.
Delivers: `substrate/` with both implementations; transcript capture; architecture.md §6 updated from draft → frozen.
Acceptance: FakeSubstrate writes canned artifacts and a transcript; ClaudeCodeSubstrate verified manually against installed Claude Code (documented in spike-notes addendum); no code outside `substrate/` references the `claude` binary (dependency test).

**P1-09 · propose command + propose role prompt** · Tier: Fable · Depends: P1-03..05, P1-08
Reads: charter §The Workflow, §Loop Mechanics (approve session, seams/unspecified); phase-0-1.md §6.
Delivers: `commands/propose.ts`; `.crucible/context/propose.md` (P1 version); bundle scaffolding per spike mechanism.
Acceptance: with FakeSubstrate, produces a bundle that passes parsers+lint; a Fake emitting an invalid bundle → exit 1 with report (agent judged, not trusted); Unspecified + Seams sections required by validation.

**P1-10 · Stub adapter** · Tier: Opus · Depends: P0-03
Reads: charter §Bindings & the Adapter Protocol, §Adapter Manifest; phase-0-1.md §7.
Delivers: `adapters/stub/` executable + manifest.
Acceptance: `resolve` and `run` against `tests.json` produce charter-schema JSON (incl. `targetFile`); malformed stdin → non-zero exit; conformance-style test file seeds `fixtures/conformance/`.

**P1-11 · Adapter client** · Tier: Opus · Depends: P1-10
Reads: same as P1-10.
Delivers: `adapters/` client in core (manifest load, spawn, zod-validated transport, ORC join, skip→fail).
Acceptance: joins stub results to oracle IDs; `skip` on an oracle target reported as fail; adapter timeout/non-zero exit/garbage JSON each → exit 3; results stable-ordered.

**P1-12 · verify command** · Tier: Opus · Depends: P1-05, P1-06, P1-11
Reads: charter §How Verify Executes; phase-0-1.md §8.
Delivers: `commands/verify.ts`, `verifyx/` report aggregation, `--json`.
Acceptance: green path on fixture; each red source (lint, oracle fail, hash void) → exit 1 with the finding attributed to its check; report JSON schema-validated; approval-hash check skipped cleanly when no approval exists yet (pre-approve verify during propose).

**P1-13 · implement command** · Tier: Opus · Depends: P1-07, P1-08, P1-12
Reads: phase-0-1.md §6; charter §Tasks live on the other side of the gate.
Delivers: `commands/implement.ts` (precondition → tasks.md generation → implement session → local verify report).
Acceptance: refuses without valid approval (exit 2, names `crucible approve`); refuses on voided hash listing mismatches; with FakeSubstrate, tasks.md generated before implementation artifacts; state events appended in order.

**P1-14 · status command** · Tier: Opus · Depends: P1-06, P1-12
Reads: charter §State & Audit; phase-0-1.md §9.
Delivers: `commands/status.ts` + `state/` reconciliation.
Acceptance: correct phase + next-command at each stage of the fixture flow; hand-corrupted state.yaml is rewritten from artifacts; config-differs warning fires when working-tree crucible.yaml ≠ merge-base.

**P1-15 · CI template** · Tier: Opus · Depends: P1-12
Reads: phase-0-1.md §2, §9; charter §The Target-Branch Rule.
Delivers: `ci-templates/crucible.yml`.
Acceptance: in a test repo (or act-style local run): PR branch config edits do not affect the verify run (target-branch config proven by a PR that loosens a glob and still fails); verify red → check red.

**P1-16 · Tracer integration test** · Tier: Fable · Depends: all P1
Reads: phase-0-1.md §10 + exit criterion.
Delivers: `core/test/tracer.test.ts` (FakeSubstrate) + documented `--real-substrate` manual runbook.
Acceptance: full propose→approve→implement→verify flow green on toy fixture in CI; the test also proves three negative paths: post-approval oracle edit → verify red; skipped oracle test → red; REQ without oracle → propose-stage red. **This test is the permanent regression anchor.**

---

Phase 2 design + tasks are written only after P1-16 is green (tracer-bullet rule).
