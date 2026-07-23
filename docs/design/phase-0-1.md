# Design — Phase 0 (Spike & Scaffold) + Phase 1 (Tracer Bullet)

Reads with: `docs/charter.md` (esp. "Loop Mechanics", "Oracle File Syntax & Adapter Binding Spec", "Configuration & Reviewer Law"), `docs/design/architecture.md`. This doc is the *how* for the thin end-to-end slice; the charter is the *what*. Anything here that Phase 1 falsifies gets amended in the same commit.

## Phase 0 — goals & exit criteria

**P0 is reconnaissance; its output feeds this design.**

1. **OpenSpec spike:** install OpenSpec at latest stable; author a minimal custom schema bundle (`proposal → specs → design → oracles → tasks` with `requires` ordering); create a change with it end-to-end; document in `docs/design/spike-notes.md`: what the schema format actually permits, how templates work, what `openspec update` regenerates, any deltas from charter assumptions. Pin the supported version range in root `package.json` + charter amendment if needed.
2. **Scaffold:** monorepo per architecture.md §1 (npm workspaces), TypeScript strict, vitest, lint/format, CI running tests on push.
3. **Toy fixture:** `fixtures/toy-repo/` — a fake project with a `tests.json` (see §7) that the stub adapter reads, plus a pre-written OpenSpec change bundle usable to exercise commands before propose exists.

**Exit:** spike notes committed; `npm test` green in CI on the scaffold; version range pinned.

## Phase 1 — scope

Thin versions of: `propose`, `approve`, `implement`, `verify`, `status`, one GitHub Actions template. Deliberately deferred to P2: tiers (all changes treated as standard), amend/override/escalate, reviewer, change types beyond `feature`, notify hooks, `why`, `doctor`, trajectory checks (transcripts are *captured*, not judged), the rich approve surface (P1 approve is terminal text + confirm).

**Exit criterion (the tracer):** on `fixtures/toy-repo`, a scripted flow — propose a toy feature → approve → implement → verify green locally → push → CI check green — passes as the P1-16 integration test.

## §1 CLI skeleton

- `commander`-based; every command wired through a shared runner that catches `CrucibleError` → exit code + hint (architecture.md §2–3). `--json` flag on `status` and `verify` for machine output.
- No interactive prompts except `approve`'s confirm (and `--yes` for tests).

## §2 Config (minimal slice)

- Load + zod-validate `crucible.yaml`: `risk.critical[]`, `risk.exempt[]`, `tiers.*.diff_cap`, `adapters.*`, `suites.*`, `trajectory.require_local_verify`, `audit.sample_rate`. Unknown keys → exit 3.
- `.crucible/settings.yaml` / `local.yaml`: only `models.*` and `notify` parsed; deep-merged (local > settings); never read by enforcement code paths (enforced by module boundary: `config/enforcement.ts` vs `config/convenience.ts`).
- Target-branch rule is a CI-side behavior: the CI template checks out target-branch config to a temp path and passes `--config-from <path>` to verify. Local verify uses working tree and `status` warns when it differs from merge-base config.

## §3 Artifact operations

- Bundle layout (confirmed by P0-01 spike, two additions): `openspec/changes/<name>/` containing `proposal.md`, `design.md`, `oracles.md`, `specs/**` (deltas), plus Crucible-owned `approval.yaml`, `state.yaml`, later `escalation.yaml`. *(Amended P0-01: OpenSpec's `new change` also creates `.openspec.yaml` (schema pin + created date) and `README.md` in the change dir — OpenSpec-owned metadata, outside the approval hash scope. Spec deltas must additionally satisfy OpenSpec's delta grammar — `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` headers and ≥1 `#### Scenario:` block per requirement — or `openspec validate`/`archive` fail; the bracketed `[REQ-*]` heading form is compatible with it.)*
- **Proposal parser** *(added P1-09)*: enforces the charter's propose contract — exactly one non-empty `## Unspecified` section and one non-empty `## Seams` section (charter §The Workflow, propose row); absence/emptiness/duplication → exit 3. Other proposal prose (Why/What Changes/Impact) is OpenSpec-conventional and not validated.
- **Oracle parser:** per charter grammar — `^## (ORC-[a-z0-9-]+-\d{3}):` heading; exactly one ` ```yaml crucible-binding ` fence before next `##`; zod-validate binding fields (`requirement`, `kind ∈ unit|property|contract|integration`, `runner`, `target | targets[]`). Any structural violation → exit 3 with heading/line named.
- **Spec-delta extractor:** headings matching `### Requirement: .* \[REQ-[a-z0-9-]+-\d+\]` → ordered list of REQ IDs (+ heading text for display).
- **approval.yaml schema:** `{version, change, approved_by, approved_at, files: {<relpath>: sha256}, amendments: [{at, files}]}` (amendments array present but unused until P2).
- **state.yaml:** `{change, events: [{at, cmd, summary}], snapshot: {phase, last_verify}}` — written last by every command; `status` reconciles from artifacts and rewrites on divergence.

## §4 Hashing

- Canonical: raw file bytes, sha256 hex. Hash scope for P1 = proposal.md, design.md, oracles.md, specs/**, every bound test file (targets resolved to paths via binding `target`'s file component — stub adapter provides a `targetFile` in resolve results to avoid core parsing target syntax).
- `verifyApproval(bundle) → {valid} | {void, mismatches[]}` — used by implement (precondition) and verify (check).

## §5 AgentSubstrate

**Settled by P1-08** — frozen shape in architecture.md §6, canonical types in `core/src/substrate/types.ts`. *(Amendment: the working draft here had the substrate computing the transcript path `.crucible/transcripts/<change>/<role>-<ts>.jsonl`; frozen contract has the caller mint it and pass `transcriptPath` in the request, so the substrate holds no change-awareness or wall-clock naming.)* Phase-1-specific notes that remain here:

- `ClaudeCodeSubstrate` is verified P0-style against the currently installed Claude Code version (documented in a spike-notes addendum); all CLI-flag specifics live inside that one class.
- `FakeSubstrate` (writes pre-canned artifacts + transcript) backs unit/integration tests so the suite runs without network.
- Success is never read from exitCode alone: after any substrate run, the calling command validates the artifacts the role was required to produce (invariant #2).

## §6 propose / approve / implement (thin)

- **propose:** args = change name + intent text. Scaffolds the OpenSpec change (spike-determined: `openspec new change <name> --schema crucible --json`; change names are lowercase kebab-case, no leading digit — propose validates the same rule), invokes substrate role=propose with `.crucible/context/propose.md` (P1 version of the prompt: emit valid bundle incl. oracles per grammar + bound test files in the toy repo's convention; include Unspecified/Seams sections). Then validates the bundle (parsers §3) and runs lint (§8) + adapter resolve; red → exit 1 with report (agent output is judged, not trusted).
- **approve:** renders scenarios + binding table in terminal, confirms, writes approval.yaml (hash scope §4), appends state event. Refuses (exit 2) if bundle invalid or lint red.
- **implement:** preconditions: approval.yaml valid (§4) else exit 2. Generates `tasks.md` via substrate (role=implement, first action) then runs the implement session; afterwards runs local verify and reports. Does not loop in P1 (single session; iteration budget is P2).

## §7 Stub adapter + adapter client

- **Stub:** executable in `adapters/stub/`; fixture `tests.json`: `[{id, file, status: "pass"|"fail"|"skip"|"missing", message?}]`. `resolve` maps targets → found/missing (+ `targetFile`); `run` returns normalized results per charter schema. Speaks the real wire protocol — it is the protocol's first consumer and the conformance seed.
- **Client:** loads manifest (`crucible-adapter.yaml`), spawns per invocation strings, streams JSON, zod-validates every message, maps `skip→fail` for oracle targets, joins results to ORC IDs via the binding table. Timeouts + non-zero adapter exit → exit 3 (a broken judge is fail-closed).

## §8 Traceability lint v0 + verify v0

- **Lint v0:** the three set checks (REQ→oracle coverage, oracle→REQ existence, binding resolution via adapter `resolve`). Archived-spec lookup deferred to P2 (P1 has no archive).
- **verify:** orchestrates: parse bundle → lint → adapter run (current-change oracles; regression = all archived bindings, empty in P1) → approval-hash check (when approval exists) → aggregate `VerifyReport {checks: [{name, status, findings[]}], verdict}` → render + `--json`. Exit 1 on any red.

## §9 status & CI template

- **status:** derives phase from artifact presence/validity (+ approval hash check), prints next command, reconciles state.yaml. Warns on config-differs-from-merge-base.
- **CI template (`ci-templates/crucible.yml`):** checkout PR; checkout target-branch crucible.yaml separately; `crucible verify --config-from ...` as a required check. Installed by hand in P1 (`init` polish is P2).

## §10 Toy fixture change (for the tracer)

A scripted "add greeting feature" flow: intent text checked into the integration test; FakeSubstrate variant runs in CI; a `--real-substrate` mode of P1-16 runs against actual Claude Code locally for manual validation.
