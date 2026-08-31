# Crucible V2 — High-Level Overview

*(Naming settled for now: the framework is **Crucible**, and "**oracles**" is retained — an established term from software-testing literature: the mechanism that decides whether a test's output is correct.)*

## Premise (unchanged from V1)

Verification effort is conserved, not eliminated. If humans stop reading code, trust must come from machine-checkable verification. Humans author and approve **intent artifacts** (specs + oracles); agents author implementation; deterministic infrastructure enforces the workflow.

**What changes in V2:** the same guarantees are delivered through a workflow that feels like a natural extension of TDD/BDD rather than a bureaucracy. V1 optimized for *impossible to bypass*; V2 optimizes for *effortless to follow* — because a framework nobody enjoys using enforces nothing.

**The whole architecture in one sentence:** Crucible's job is to shrink the trusted computing base from "all the code" down to "the specs, oracles, and harness" — and then concentrate scarce human attention exclusively there.

## The Core Inversion

The human-in-the-loop moves from **approving code** to **approving artifacts**. One human gate, placed where leverage is highest: at the end of `propose`, before any implementation exists. Reviewing declarative artifacts (scenarios, oracles, scope) is far cheaper than reviewing procedural code — and exploits *recognition over recall*: humans are bad at enumerating edge cases from scratch, but good at spotting the missing one in a list the propose agent generates.

## The Workflow — Artifact-Derived CLI, Agent Skills

```
init ──► propose ──► approve ──► implement ──► verify ──► archive ──► PR
        (agent skill)   ★ HUMAN    (agent skill)  (deterministic) (complete)
                        TERMINAL
```

Every CLI command is stateless, reads only artifacts, and **refuses to run if
its precondition artifact is missing or invalid**. Generated agent skills are
thin steering surfaces inside the user's active Codex/Claude session: they ask
the project-local CLI what is allowed, author files, and return them to the CLI
for validation. The CLI never spawns an agent. Conversation history, skill
prose, caches, and agent self-report have no authority.

| Command | Actor | Produces | Precondition |
|---|---|---|---|
| `explore` | Agent + human | Ephemeral notes, options, tradeoffs | — (optional) |
| `propose` | Agent via generated skill in the active session | Proposal, all schema-required pre-approval/custom artifacts, **oracles (declarative + bound test code)**, explicit out-of-scope and seams sections | Initialized project |
| `approve` | **Human** | Approval artifact containing content-hashes of every approved artifact | Complete proposal bundle |
| `implement` | Agent via generated skill in the same active session | **tasks.md (generated as its first action)**, then code + ordinary tests | Valid approval artifact |
| `verify` | Deterministic script | Machine-parseable verdict; no LLM/API key | Implementation exists |
| `archive` | Deterministic CLI, usually invoked by a skill after human confirmation | Synced canonical specs + complete archived change | Valid seal + green verify |

### Key design decisions inside the loop

1. **Oracle artifact format** — two-part: a declarative scenario section (Given/When/Then with stable IDs, e.g. `ORC-auth-003`) that the human reviews, plus a binding mapping each ID to an executable check (test path + name, property test, DB constraint, architecture rule). **The artifact is not the test code**: oracles.md holds natural language + pointers; the actual check code lives in the test suite as real files — but is still written at propose-time so the gate covers it. The human reads scenarios line-by-line and only spot-checks test code.
2. **Oracles are written at propose-time, before approval.** The human gate covers them. After approval, oracle paths are **immutable for the implement step** — any diff touching them fails CI. This preserves V1's "oracles precede implementation" with zero added ceremony.
3. **Traceability linter** enforces three-way integrity: every SHALL/scenario in the spec delta ↔ at least one oracle ID ↔ an executable check that actually exists and is collected by the runner. A requirement without an oracle fails the build — it is a wish, not a spec.
4. **Approval is tamper-evident, not ceremonial.** The approval artifact stores content-hashes; CI re-verifies them. Any post-approval edit to spec or oracles silently invalidates the approval — no protected paths or CODEOWNERS needed for small teams (both remain available as optional hardening for larger orgs).
5. **`verify` is a script, not an agent.** Deterministic checks (oracles,
   tests, traceability, seals, concrete policy) run as code and exit 0/1. AI
   review is a separate optional check: `off`, `advisory`, or `required`.
   Agent self-report is never a completion signal.

## Two Venues, One Truth: Local vs. CI

The split is **feedback vs. enforcement** — not feature-specific vs. generic.

| | Part 1 — Local | Part 2 — CI (GitHub Checks) |
|---|---|---|
| Purpose | Fast iteration loop | Trust |
| Authority | **Advisory** (dev machine is agent-controlled, inherently untrusted) | **Enforcing** (Crucible-maintained GitHub Actions; full hermetic sandboxing is a parked hardening milestone) |
| What runs | Same `verify` command | Same `verify` command re-run in CI, **including all feature-specific oracles + unit + regression suites** |
| Plus | — | Static suite, traceability, oracle immutability, approval hash, adapter pins, and concrete repository policies |
| Outcome | Green = ready to archive/submit | Required `verify` result supplies merge authority; optional `ai-review` follows `off|advisory|required` policy |

If CI only ran generic checks, local verification would be the only place oracles execute — on hardware the implementing agent controls. Re-running oracles in CI is what keeps V1's core property alive: **the only path to green is through the code.**

Mutation testing is retained but made humane: scoped to the diff's touched modules; blocking only on risk-routed paths, elsewhere async (files ratchet issues instead of blocking merges).

## Built On, Not From Scratch

V2 is a **layer over OpenSpec's artifact format** (specs/ as current truth, changes/ as proposed deltas, archive merges truth forward) rather than a new tool or a patch into their codebase. What V2 adds is precisely the differentiator OpenSpec lacks: the oracle artifact type, the traceability linter, the deterministic verify runner, the approval-hash mechanism, and the CI enforcement half. Consuming their format (rather than forking their code) grants familiarity to existing SDD users while insulating against their roadmap.

## What Survives From V1 Unchanged

- Stateless CLI operations; hand-offs are artifacts, not messages; direction emerges from preconditions even though one interactive agent conversation may author multiple stages.
- "Done" = artifact exists and validates — never agent self-report.
- Deterministic CI verify as merge authority; agents cannot silently modify sealed oracles/specs or select the config/verifier that judges their PR.
- Deterministic risk routing + random audit sampling of auto-merges.
- **The ratchet (dual-trigger in V2):** every escaped *defect*'s postmortem ships a gate commit (new oracle, rubric line, or rule); every *agent failure* (escalation loop, budget blowout, trajectory violation) ships a harness commit (prompt fix, context-boundary change, tool addition). Defects ratchet the gates; agent failures ratchet the harness. The system only gets stricter.
- Convenience and enforcement remain separate layers; deleting the tooling leaves the workflow enforced, just tedious.
- Escalation rule: ambiguity is a spec bug, fixed upstream at propose, never improvised at implement.

---

# DevEx Design Principles & Decisions

**Organizing principle:** DX dies wherever ceremony is disproportionate to risk, and wherever the tool blocks without teaching. Every decision below fixes one of those two failure modes while preserving a named guarantee.

**Meta-rule:** every convenience must be computed deterministically from artifacts — never self-declared by an agent, or by a human under deadline pressure.

**Feature test:** *does this ask the human for information the system could compute, or attention the system could defer?* If yes, it's a DX bug even if it feels rigorous. Rigor lives in the oracles and the CI contract; everything else should feel like the tool is doing the work.

## Additions

| # | Feature | What it does | Guarantee preserved / how |
|---|---|---|---|
| 1 | **`crucible status`** | The `git status` of the loop: active change, artifact state, what's blocked on what, exact next command. Corollary: every precondition failure names its fix ("no approval artifact — run `crucible approve`"). | None at risk — errors teach the workflow instead of documentation |
| 2 | **Concrete deterministic policy (Phase 4R)** | Required artifacts, oracle coverage, sealed inputs, configured suites, size caps, and protected trust paths are checked directly. Tier-dependent ceremony is parked until the thin lifecycle is qualified. | Every active rule is observable and recomputed; no label supplied by an agent changes enforcement. |
| 3 | **`approve` as the flagship experience** | The one human touchpoint gets disproportionate investment: the whole bundle rendered as a single readable review surface (scenarios, unspecified/out-of-scope, spec-delta diff, scope map) with inline edit-and-re-hash. | Strengthens the gate — a review that reads like a well-organized PRD gets *more* attention, not less |
| 4 | **`crucible amend`** | Cheap mid-implementation spec fixes: human approves just the delta, hashes re-seal, implementation continues. | Keeps "ambiguity is fixed upstream" viable — it only survives if fixing upstream is a thirty-second operation; otherwise people batch fixes or route around the gate |
| 5 | **Override automation (parked)** | Phase 4R ships no merge-gate bypass while the ordinary lifecycle is being re-qualified. | Avoids designing exceptional lanes before the normal path is proven. |
| 6 | **`verify --watch`** | Scoped to affected oracles; sub-second where possible. Local loop feels like TDD red-green. | If local verify is slow, nobody runs it and CI becomes the first place failures appear — the slowest possible feedback loop |
| 7 | **Progressive adoption + brownfield `init`** | `init` detects the stack, writes risk-routing defaults + CI workflow; only governs paths touched by new changes. Adoption in layers: propose/approve → oracles + traceability → CI enforcement → routing. | Each layer is independently valuable; the framework never demands faith up front. Full guarantees apply once fully adopted — partial adoption is honest about being partial |
| 8 | **Meet developers where they are** | Agent workflows for OpenAI Codex, Claude Code, Cursor, etc. (OpenSpec's existing surface) driving the CLI; CLI remains the substrate of record. Plus `crucible why <failure>`: trace any red check to the exact oracle, rubric line, or rule that fired. | Transparency makes people trust a gate instead of resenting it; the CLI-as-substrate keeps chat agents unable to bypass anything |

## Modifications from V1

- **Diff-cap/tier strategy is parked for Phase 4R.** A repository may configure a concrete size policy, but proportional ceremony and stacked-change mechanics return only through a later design.
- **The 10% audit sample becomes a weekly digest**, not per-PR interruptions. Same statistical guarantee, batched attention.
- **AI-review verdicts must be actionable when enabled:** fail = rubric line + evidence + suggested remediation, machine-parseable so the implement agent can respond. A bare "rejected" is invalid.
- **Escalation resolution is one command**, folded into `amend`: agent files the escalation artifact, human resolves with spec patch + delta-approval, loop resumes. "Stop on ambiguity" stays; un-stopping becomes trivial.

## Exclusions from the user-facing surface

- **Conversational work orders, session checkpoints, iteration budgets, and Crucible-selected agent sandboxes** are not part of the reset workflow.
- **Any second approval ceremony.** One gate, forever. "Just one more sign-off" is how V1 happened.

---

# Extensibility & Tech-Agnosticism — The Adapter Architecture

V2 is language-, framework-, and tech-agnostic via an **adapter architecture** (LSP / Terraform-provider model: one protocol, many providers). The critical design call: **adapters plug in at the front of the loop, not post-implementation.** Oracles have an executable half whose bindings must be written at propose-time, validated by the traceability linter, and runnable by local verify — all before code exists. Tech-specificity is therefore resolved once at `init`, then used everywhere.

## The Split

**Core (100% agnostic):** artifact schemas, artifact-derived preconditions, approval hashing, traceability *semantics* (SHALL ↔ oracle ID ↔ existing check), deterministic verify, CI trust contract, generated-skill definitions, and CLI. The core never imports a test framework — it only speaks the adapter protocol.

**Adapter (all tech knowledge):** implements a small interface:

| Method | Responsibility | Powers |
|---|---|---|
| `detect` | Am I applicable to this repo? | `init` auto-configuration |
| `resolve` | Batch dry-run: do these targets exist/collect? | Traceability linter (bindings must resolve) |
| `run` | Execute targets; emit results in Crucible's normalized JSON schema | Local + CI `verify` (core parses one schema, ever — SARIF/JUnit-XML precedent) |
| `scope` *(optional)* | Map a diff → affected checks | `verify --watch`, scoped local regression runs, diff-scoped mutation |

*(Finalized signatures, transport, and lifecycle: see the Oracle File Syntax & Adapter Binding Spec section.)*

Oracle bindings become adapter-mediated: the artifact declares `runner: pytest, target: tests/auth/test_lockout.py::test_five_failures`; core hands it to whichever adapter claimed the `pytest` runner. Identical oracle format for a Rust repo — just `runner: cargo-test`.

## Historical Capability/Tier Negotiation — Parked for Phase 4R

Not every stack has mature mutation-testing or architecture-rule tooling. Adapters **declare capabilities** (`unit`, `property`, `contract`, `mutation`, `arch-rules`, `sast`, ...); tiers and risk routes **declare requirements** ("critical tier requires `mutation`"). When a required capability is missing, the framework degrades **loudly and honestly** — e.g., route the PR to human review with "mutation unavailable for this stack" — never silently skip. The guarantee model stays truthful across ecosystems of different maturity, and adapter authors get a visible gap list.

## Adapters Are Part of the Trusted Computing Base

*(TCB — security-engineering term: the minimal set of components that must be trusted for the system's guarantees to hold, because compromising any of them collapses the whole trust story. Design goal: keep it small, and concentrate scarce human review exclusively there. Crucible's TCB: specs, oracles + bound tests, rubric, adapters, `.crucible/context/`, CI workflows, enforcement config, and the harness itself — everything the implement agent cannot touch, which is precisely why the implement agent can be fully untrusted.)*

An adapter decides whether checks pass — it is exactly as security-critical as the harness. Therefore:

- **Pinned by version and content hash** in a lockfile covered by the approval-hash mechanism.
- **Immutable to the implement agent**, same as oracle paths — any diff touching adapter config/lockfile after approval fails CI.
- **Conformance suite required** (harness-as-product applied to adapters): the core runs every adapter against fixture repos — `resolve` must find these checks, `run` must fail this deliberately broken one, etc. "Certified" = conformance passes. This is also the community story: reference adapters ship first-party (**`java-junit` first** — see the Binding Spec — driven by the first Crucible-built project being Java + Spring Boot; Python/TypeScript follow); the ecosystem covers the long tail — the only way agnosticism scales without owning *n* ecosystems.

## DX Surface

Invisible in the happy path: `crucible init` runs `detect` across installed adapters, proposes matches ("Found pyproject.toml → python-pytest adapter, pin v1.4.2?"), writes the lockfile, done. Polyglot repos map adapters to path globs in the same config as risk routing. `crucible why` gains one more traceability layer: failure → oracle → adapter → underlying tool output.

## Explicit Non-Feature: Ad-Hoc Check Commands

Arbitrary shell strings in config ("custom checks") are a bypass vector — an agent could satisfy a "check" that is really `exit 0`. The escape hatch for exotic stacks is a **`generic-command` adapter** whose config is covered by the lockfile hash and whose use **downgrades the tier/routing** (loud degradation, again). Convenience never gets to be unhashed.

---

# Loop Mechanics — Settled Details

## The Oracle Artifact, Precisely

- **oracles.md** = the human-readable half: Given/When/Then scenarios with stable IDs, each linked to a SHALL in the spec delta, plus a binding per ID (`runner: pytest, target: tests/auth/test_lockout.py::test_five_failures`).
- **The check code** = real test files in the suite, written by the propose agent *before* approval, referenced by the bindings. Not part of the artifact, but inside the approval hash and immutable post-approval.
- **Division of review labor:** the human reads scenarios line-by-line, spot-checks the test code, and relies on the traceability linter to guarantee every pointer resolves.

## Historical Tier Computation Rules — Parked for Phase 4R

- **Nobody selects the tier.** The propose agent *suggests* one (UX nicety); the CLI recomputes it deterministically from observable facts (normative spec delta present? touched paths vs. risk globs? diff size?); CI recomputes again. Disagreement between claim and recomputation = fail.
- **Oracles are triggered by spec deltas, not code changes.** A pure refactor changes no promised behavior → no spec delta → no new oracles. Its correctness criterion *is* the accumulated regression suite + an untouched spec.
- **Lower tiers skip authoring ceremony, never executed checks.** Proposal depth, new-oracle authoring, and blocking mutation scale down; everything already in the suite always runs.

## Three Kinds of Tests — Purpose, Strategy, Trust

| | **Test oracles** | **Unit tests** | **Regression suite** |
|---|---|---|---|
| **Purpose** | Prove code honors *human-approved intent* (spec conformance) | Help build a correct *implementation* (code-level scaffolding) | Prove new changes don't break *past promises* |
| **Authored** | Propose-time, pre-approval, by propose agent | Implement-time, by implement agent | Not authored — *accumulated*: archived changes' oracles roll into it |
| **Mutability** | Immutable post-approval (hash + CI check) | Freely mutable by implement agent | Immutable; only grows (the ratchet adds here) |
| **Traceability** | Linted: every SHALL ↔ oracle ID ↔ test | None required | Inherited from source oracles |
| **Trust weight** | The verdict on the current feature | **Zero** — agent-authored, agent-mutable, pure scaffolding | The verdict on everything else |

Key insight: unit tests carry no trust, and that's fine — their job is helping the agent build, not judging it. Judgment comes only from oracles (current change) and the regression suite (all past changes). This is also what makes the refactor rule above sound.

## OpenSpec Integration Mechanics

- Custom schemas are first-class in OpenSpec: project-level bundles at `openspec/schemas/<name>/` (schema.yaml + templates) with dependency ordering via `requires`. They are project files — **they survive OpenSpec upgrades** (upgrades regenerate AI instruction/skill files, not project schemas). *(Amended P0-01: verified at OpenSpec 1.6.0, but schema commands are labeled experimental upstream — Crucible pins an exact OpenSpec version and treats upgrades as deliberate, spike-reverified events; see docs/design/spike-notes.md.)*
- **Crucible ships a `crucible` schema bundle** (proposal → spec deltas → design → oracles → tasks, with `requires` ordering). `crucible init` installs it into `openspec/schemas/crucible/` and sets it in config.yaml — the same path community schemas use.
- **Upgrade procedure (repeatable, idempotent):** `openspec update` + `crucible doctor` (verifies the bundle is intact/current; re-installs if OpenSpec's schema format changed).
- **Tasks live on the other side of the gate.** OpenSpec deliberately has no approval concept (artifacts are freely editable), so approval gating is Crucible's job — and the cleanest enforcement is structural: `crucible implement` generates tasks.md as its *first action* and refuses to run without a valid approval artifact. Tasks are the agent's work breakdown, not human review material — this also shrinks the gate bundle. Approval hash covers proposal/spec deltas/design/oracles + bound test files; tasks.md is downstream and outside the hash.

## Approval, Amend, Override — Wire Format

- **`crucible approve`** writes a committed file (`changes/<name>/approval.yaml`): SHA-256 content-hash of each artifact in the review bundle and each bound test file, plus who/when. CI recomputes; any mismatch voids the approval.
- **`crucible amend`** (mid-implementation spec fix): shows the diff between approved state and current artifacts; human confirms; a delta entry with new hashes is appended to approval.yaml. A thirty-second re-seal, not a fresh ceremony. Escalation resolution folds into this same flow.
- **Override/escalation automation is parked in Phase 4R.** Changing approved intent uses `amend` plus a new human seal; the reset MVP has no merge-gate bypass.

## CI Posture for the Phase 4R Reset

Deterministic `verify` is credential-free and required: current oracles, archived
regression oracles, declared suites, traceability, approval hashes, immutable
oracle inputs, adapter pins, and concrete repository policy. AI review is a
separate `off|advisory|required` check and the default never requires an API
key. A candidate never selects its own enforcement config, framework pin,
adapter pin, or historical harness input.

The preferred GitHub authority is a ruleset-required workflow stored outside
the candidate repository and run on the restricted `pull_request` event.
Repositories without that capability receive either a future GitHub App or an
honestly advisory repository-local workflow; `doctor --ci` reports which grade
is actually installed. `pull_request_target` does not execute candidate code by
default.

## Optional AI Reviewer — Design

- **Rubric:** versioned YAML checklist at `.crucible/rubric.yaml` — each line an ID + criterion + what evidence constitutes failure (e.g. `R-007: implementation embeds a decision the approved spec does not determine`). A TCB path: hash-pinned, immutable to the implement agent; the ratchet appends lines to it (postmortem concludes "the reviewer could have caught this class but had no criterion" → new line → every future review checks for it).
- **`ai-review`:** independent agent context. Inputs: diff + spec delta + oracles + rubric. Output: strict JSON verdict — `pass` | `fail`; on fail: rubric line ID + evidence pointer + suggested remediation. In `required` mode malformed/missing output is red; in `advisory` mode findings never block; in `off` mode no model call occurs. It is never an input that changes deterministic `verify`.
- **Default rubric ships small (~12 lines):** vacuous-test smells, oracle-adjacent code weakening, swallowed errors, unjustified dependency additions, concurrency red flags, secret patterns, spec-conformance gaps oracles can't see.
- **DX:** users never configure it to start; they *encounter* it only through actionable failure messages via `crucible why`, and *edit* it only via the ratchet.
- **Deferred:** the rubric's own regression eval suite (fixture diffs with known verdicts, re-run on model/rubric change) — parked alongside hermetic sandboxing as hardening.

## The Approve Session — Validation, Editing & the "One Rich Gate"

- **During approve, nothing is sealed yet** — so re-validation is not hash-based. Inline edits re-run the same validators propose ran: schema checks + binding resolution. Editing a scenario's *expected behavior* marks its oracle "scenario changed after test authored"; the propose agent regenerates the bound test and the human sees that test diff before confirming. Hashes seal the *final* state — they detect tampering after the seal, not during review.
- **TDD/BDD alignment — one rich gate, not two.** At approve, the BDD scenarios *and* their executable test code already exist on disk and appear in the review surface; implementation starts from red. No second gate follows oracle-code authoring. Scenario and bound test render side-by-side, and deterministic red-on-base/collection checks backstop the review.

## Editing Artifacts — Pre- vs. Post-Approval

- **Pre-approval:** direct edits are allowed (OpenSpec's grain; typo fixes shouldn't need ceremony), but the *advertised* path is `crucible propose --revise "switch to token-bucket"` — the agent regenerates all dependent artifacts coherently, which is the sync guarantee. **Staleness tracking** covers the escape hatch: the bundle records per-artifact generation hashes in dependency order; if design.md changed after oracles.md was generated, `approve` refuses ("design edited after oracles — run `--revise` or confirm consistency"). Manual edits allowed; silent desync impossible; the agent path is simply the easiest path.
- **Post-approval:** the hash seal voids on any direct edit; `amend` is the only path, and it routes through the agent, which regenerates dependents.

## How Verify Executes (and Scopes)

- **Wiring:** oracle bindings name their runner + target; verify hands each to the adapter that claimed that runner. Unit/regression suites need no per-test wiring — `init` records the project's standard test invocation, and the regression suite is structurally known: the accumulated oracle bindings of all archived changes.
- **Selection:** current-change oracles always run in full, everywhere. The regression suite is scoped *locally* via the adapter's `scope` (diff → affected tests) to keep the loop fast; **CI runs the full regression suite** — "the adapter's scoping was wrong" must never be a merge path. (Scoped-on-PR + full-on-merge-queue is a later optimization, not v2.0.)
- **The implement inner loop** is plain red-green TDD against sealed goalposts: code → `crucible verify` → read machine-parseable failures → fix → repeat to exit 0 → push. Local green is the *signal* it's ready; CI green is the *authority*.

## Traceability Lint — Mechanics

Three extractions + set arithmetic: (a) every normative statement in the spec delta (SHALL/scenario IDs); (b) every oracle ID with its SHALL-link and binding; (c) the set of actually-collectible test targets, via adapter dry-run resolution (no execution). Checks: every SHALL has ≥1 oracle (else "requirement without oracle — a wish"); every oracle points at an existing SHALL (else orphan); every binding resolves (else broken pointer). Failures name the exact missing link. Milliseconds; no tests run.

## Historical Tier Design — Parked for Phase 4R

The following tier material records the P2/P3 design but is not an active Phase
4R contract. No reset task may port tier-dependent ceremony, routing, mutation,
or override behavior without a later ratified design after P4R exit.

- Recomputed deterministically at propose, approve, implement, and CI. Agent's suggestion is a UX nicety; claim ≠ recomputation → fail.
- Inputs: spec-delta presence, risk-glob matches, diff size. (*Glob* = `.gitignore`-style wildcard path pattern: `payments/**` = everything under payments/, any depth.)
- **Force up, never down:** `--tier critical` per change, or permanently via globs in crucible.yaml (the recommended fix — it corrects the facts). Downgrading is only possible by changing the facts the computation reads; a self-declared downgrade is exactly what the meta-rule forbids.
- **Honest residual** (refactor tier): behavior that *no past oracle ever pinned* can drift unseen. That's a spec-coverage gap — the exact escape class the ratchet exists to close.

## Tier Definitions (settled)

The dial that makes ceremony proportional to risk. Three tiers; all selection is computed (agent suggests, CLI + CI recompute; force up allowed, force down impossible).

| | **Trivial** | **Standard** | **Critical** |
|---|---|---|---|
| **Purpose** | Changes that promise nothing new: refactors, docs, chores, dependency-free cleanups | The default: new or changed behavior on non-risk paths | Changes where a defect is expensive: risk paths, or anything the team forces up |
| **Selected when** | No spec delta AND no risk-glob match AND diff ≤ trivial cap (default 150 lines) | Spec delta present AND no risk-glob match (or a trivial change exceeding its diff cap) | Any risk-glob match (wins regardless of spec delta), or `--tier critical`, or a permanent glob |
| **Propose bundle** | One-paragraph proposal (+ optional design note); **no new oracles** — the regression suite is the correctness criterion | Full bundle: proposal, spec delta, design, oracles, unspecified/out-of-scope, seams | Full bundle, deeper: more oracle coverage expected (incl. property/integration kinds); seams must be substantive |
| **Approve experience** | ~1 minute: "moving code, promising nothing new" — confirm | One rich sitting: scenarios + bound tests side-by-side | Same, plus **per-oracle test acknowledgment** required |
| **Executed checks** | Full regression + static suite + traceability + hashes + trajectory + reviewer — *always, like every tier* | Same + current-change oracles; mutation diff-scoped **async** (files ratchet issues, non-blocking) | Same + mutation diff-scoped **blocking** |
| **Merge routing** | Auto-merge on green | Auto-merge on green (subject to the random audit digest) | **Never auto-merges** — routes to human PR review with a focused summary |
| **Diff cap (default)** | ≤150 lines | ≤400 per stacked entry | ≤400 per stacked entry |

Three rules keep the table honest: a risk-glob match always dominates (a "trivial" one-liner in `payments/**` is critical); a spec delta guarantees at least standard (new promises always get oracles and a real gate); and the executed-checks row barely varies by design — **tiers scale authoring ceremony and merge routing, never the safety net.** All caps and globs are crucible.yaml defaults, tunable per repo.

## Change Types — Schema Templates

The Crucible schema bundle ships change *types*, each with its own artifact sequence and verify rules: **`feature`** (full bundle), **`bugfix`** (slim proposal + **mandatory reproduction oracle** + a red-on-base/green-on-fix verify rule: the new test must *fail* on the pre-fix commit and *pass* on the fix — CI-checked, no honor system), **`refactor`** (thin bundle; no spec delta permitted). `crucible propose` infers the type from the description and says so; `--type` overrides.

## State and Audit in Phase 4R

- `status` derives phase and allowed next actions from artifacts, adapter-grounded bindings, seals, and verification evidence. There is no committed workflow-state file.
- Any performance cache is gitignored, disposable, and forbidden as an enforcement input. Git history, approval generations, archived change artifacts, and CI checks form the audit record.

## Historical Escalation Design — Parked for Phase 4R

1. **Instructed** (soft): the implement agent's static context: on any decision not derivable from the approved spec, stop and run `crucible escalate`.
2. **Structural** (hard): `escalate` writes escalation.yaml and ends the run; while it exists unresolved, `crucible implement` refuses to resume. Resolution flows through `amend` (spec patch + delta-approval).
3. **Detected** (backstop): rubric line R-007-style ("implementation embeds a decision the spec doesn't determine"), trajectory checks, and downstream oracles/postmortems — each slip ratchets a new rubric line. Improvisation can't be *prevented* with certainty; it is made detectable, unprofitable, and progressively rarer.

## Agent Skill Surfaces

- `init` renders one provider-neutral workflow definition into supported Codex, Claude Code, and later tool-specific skills/commands. These wrappers drive the project-local pinned CLI inside the already-active session.
- The CLI supplies deterministic scaffolding, artifact instructions, status, validation, sealing, verification, and archive operations. It never invokes an agent binary.
- Skill text and conversation history are convenience surfaces. Hash-covered artifacts and CLI judgment remain the authority.

## Notify Hooks

- Configured in the **convenience layers** — team channels in `.crucible/settings.yaml`, personal hooks in gitignored `.crucible/local.yaml`: standard hooks (terminal exit message, desktop notification, Slack/webhook, GitHub issue or PR comment) plus custom (`notify: [{on: escalation, run: ...}]`). Fires on escalations, overrides, and verify outcomes for unattended runs. CI-side blockers (risk-routed PRs, red checks) are GitHub-native — you're notified the way you are for any PR today.
- **Hooks are convenience, never enforcement:** a failed webhook can't unblock anything — the blocker is the artifact, and `crucible status` remains the on-demand dashboard.

## Adoptions from "The New Software Lifecycle" (Osmani / Google whitepaper, Jul 2026)

Independent validation first: the paper's model-plus-harness framing (~10% model / 90% harness) is our harness-as-product principle as an industry finding; its observation that implementation compresses while spec and verification stay slow — making specification the bottleneck — is the shape of our loop; and its point that agents unlock previously-too-risky maintenance work is exactly what the refactor tier + regression suite enable. Five ideas adopted:

1. **Trajectory verification.** Verify was 100% output-side; the paper's output-vs-trajectory eval split exposes the gap ("an answer that looks right but skipped its checks is more dangerous than one that's obviously broken"). V2 addition: the implement agent's session log is stored as an artifact under `.crucible/`; `verify` gains cheap deterministic trajectory checks — was local verify actually run before push? Were there *attempted* writes to oracle/rubric paths (attempts are red flags even if reverted)? Did iteration count blow the budget? The adversarial reviewer may consult the trajectory, not just the diff. Extends "done ≠ self-report" from *what* was produced to *how*.
2. **Model routing as a config knob.** A `models:` block in Crucible config assigns a model per command: propose gets the strongest (spec quality is the bottleneck — skimping there is false economy), implement mid-tier, adversarial reviewer cheap **and ideally a different model family** (cost lever + mild decorrelation benefit). Zero DX cost; a real TCO lever.
3. **Static/dynamic context boundary as versioned harness code.** Each stateless agent's static core stays minimal (role + invariants + rubric pointer); everything change-specific arrives dynamically via the artifact bundle (progressive disclosure). The boundary is an explicit, versioned harness file — PR-reviewed, and movable by the ratchet (when failures show a rule got forgotten, it migrates into static context).
4. **Ratchet dual-trigger.** "Most agent failures are configuration failures" → defects ratchet the gates; agent failures ratchet the harness (see What Survives From V1).
5. **Seams enumeration in propose.** The "80% problem" (agents nail the first 80%; the last 20% is edge cases and seams between systems) is also our acknowledged cross-feature blind spot. The propose template now requires a seams section — external systems touched, contracts crossed, concurrent changes in flight — feeding the human gate and an integration-oracle category. A partial mitigation, honestly labeled: it drags the riskiest unknowns into the reviewed bundle without claiming to verify emergent behavior.

**Consciously not adopted:** the paper's vibe-to-engineering spectrum implies per-task human judgment about how much verification to apply. Our tiers look similar but are deterministically computed — "knowing where to draw the line" per task is precisely the judgment-under-deadline-pressure failure mode the meta-rule exists to prevent.

**Borrowed motto for the parked harness-eval suite:** set the bar at the eval, not the demo.

---

# Oracle File Syntax & Adapter Binding Spec (settled)

**Design constraints:** human-readable at the gate (scenarios read like a PRD), deterministically parseable (linter, milliseconds, zero ambiguity), hashable (approval seal), adapter-neutral (core never understands pytest), OpenSpec-native (lives in the change bundle, follows their markdown conventions).

## oracles.md — Markdown with Fenced Binding Blocks

Chosen over pure YAML (miserable to review) and pure prose (unparseable): each oracle is a heading + Given/When/Then prose + exactly one fenced `yaml crucible-binding` block. Humans read prose; the linter extracts only the fences; the halves sit inches apart so drift is visible in review.

````markdown
# Oracles — account-lockout

## ORC-lockout-001: Fifth failure locks the account
**Given** an account with 4 consecutive failed login attempts
**When** a 5th attempt fails
**Then** the account is locked and subsequent correct-password logins are rejected

```yaml crucible-binding
requirement: REQ-auth-lockout-1
kind: unit
runner: pytest
target: tests/auth/test_lockout.py::test_fifth_failure_locks
```

## ORC-lockout-002: Refund totals never exceed capture (property)
**Given** any sequence of partial refunds against a captured payment
**Then** the sum of refunds never exceeds the captured amount

```yaml crucible-binding
requirement: REQ-pay-refund-3
kind: property
runner: pytest
target: tests/payments/test_refund_props.py::test_refund_sum_invariant
```
````

**Parse rule (deterministic):** an oracle = an `## ` heading matching `^## (ORC-[a-z0-9-]+-\d{3}):` followed by exactly one `crucible-binding` fence before the next `## `. Anything else fails schema validation at propose-time — malformed structure never reaches the gate.

## Requirement IDs in the Spec Delta

Linking by heading text is fragile (rename = silent orphan). Spec-delta requirement headings carry stable bracketed IDs — a pure-additive extension of OpenSpec's heading convention:

```markdown
### Requirement: Account lockout [REQ-auth-lockout-1]
The system SHALL lock an account after 5 consecutive failed login attempts.
```

**ID grammar:** `REQ-<domain>-<slug>-<n>`, `ORC-<slug>-<seq>`. IDs are immutable once approved and never reused (sequences only grow; deleting an oracle retires its number). The linter's three-way check becomes exact string matching: every `REQ-*` in the delta appears in ≥1 binding's `requirement:`; every binding's `requirement:` exists in the delta **or in the archived spec** (which is how bugfix/ratchet oracles like `ORC-refund-013` legally reference old requirements); every `target` resolves.

## Bindings & the Adapter Protocol

**The `target` is an opaque string** minted in the runner's native addressing scheme (pytest node ID; `jest: src/auth.test.ts#locks account after 5 failures`; `cargo-test: auth::lockout::fifth_failure_locks`). Core never interprets it. The adapter claiming the runner honors exactly two verbs over targets:

- **`resolve(targets[]) → {target: found | missing}`** — batch dry-run collection, no execution. Powers the linter and propose-time validation.
- **`run(targets[]) → results[]`** — execute, return normalized results.

**Normalized result schema** (the only shape core ever parses):

```json
{ "target": "tests/auth/test_lockout.py::test_fifth_failure_locks",
  "status": "pass | fail | error | skip",
  "message": "assert 401 == 200",
  "location": "tests/auth/test_lockout.py:41",
  "duration_ms": 182 }
```

Core joins results back to oracle IDs via the binding table and renders `✗ ORC-lockout-001 (REQ-auth-lockout-1): assert 401 == 200`. **`skip` maps to fail for oracle targets** — a skipped judge is a fail-closed event; otherwise `@skip` is the cheapest reward hack in the framework.

**Cardinality rules:** one oracle may bind multiple tests (`targets:` list; all must pass); one test may serve multiple oracles (the mapping is a relation, not a bijection); one requirement, many oracles is normal. Forbidden: a binding with zero requirements, or a requirement with zero oracles.

**v2.0 simplification — every oracle binds to a test.** `kind:` (`unit | property | contract | integration`) is honest metadata driving review emphasis and future capability negotiation, but all kinds execute through test runners in v2.0: a DB-constraint oracle is a test proving the constraint fires; an arch-rule oracle is a test invoking the arch-lint tool. Native `sql-constraint` / `arch-rule` runners become adapters later without touching this format — the seam is designed, not yet built.

## Adapter Manifest & Transport

Declared at install, hash-pinned in the lockfile:

```yaml
name: python-pytest
version: 1.0.0
runners: [pytest]
capabilities: [unit, property, integration, scope]   # no 'mutation' → capability negotiation applies
invocations:
  resolve: "crucible-adapter-pytest resolve --stdin-json"
  run:     "crucible-adapter-pytest run --stdin-json --report-json"
  scope:   "crucible-adapter-pytest scope --diff -"
```

Adapters are **separate executables speaking JSON over stdin/stdout** — language-agnostic, trivially hashable, sandboxable later.

**The regression suite falls out for free:** it is the union of `crucible-binding` blocks across all archived changes. `verify` collects, groups by runner, batches per adapter. No separate registry — **archiving is registration.**

## First Reference Adapter — `java-junit`

**Adapters map to test runners, not language + framework + tech combos** (a direct consequence of opaque targets). One `java-junit` adapter (detecting `pom.xml`/`build.gradle`; targets addressed as `com.acme.auth.LockoutTest#fifthFailureLocks`) covers plain Java, Spring Boot, Quarkus, Micronaut — anything JUnit-based. A `@SpringBootTest` + Testcontainers integration test is, to the adapter, just a slow JUnit test; `kind: integration` metadata captures the distinction. Runners number a handful per ecosystem; frameworks number in the hundreds — the design deliberately puts adapters on the small side of that ratio.

Per-verb complexity, honestly graded for the JVM:

- **`detect`** — trivial: file existence + Maven-vs-Gradle pick.
- **`run`** — easy: execute with test filters (`gradle test --tests ...` / Surefire `-Dtest=...`), parse the JUnit XML reports both tools emit natively, translate to the normalized JSON.
- **`resolve`** — the one honest wrinkle: the JVM lacks pytest-style `--collect-only` ergonomics, so the adapter bundles a small helper (~100 lines) on the JUnit Platform Launcher API — the official discovery mechanism — to enumerate tests without executing. Discovery is where ecosystems differ most; `resolve` exists as its own verb precisely to quarantine that difference inside the adapter.
- **`scope`** — skipped for v2.0 (optional in the protocol): local verify runs the full regression suite instead — slower local loop, zero correctness cost, CI is full-suite anyway. Add module-level diff mapping later when suite size hurts.

**The addressable-subset rule:** we control both sides of the seam — the propose agent writes the oracle tests the adapter must address. So the harness requires oracle-bound tests to be plainly addressable (concrete `Class#method`; no `@TestFactory` dynamic tests or exotic parameterized naming *for oracle targets*). The adapter handles only the well-behaved subset; the implement agent's own unit tests can be as exotic as it likes — nothing addresses those by target.

Realistic build estimate: a few days — thin CLI wrapper (any language) + Launcher-API discovery helper + XML normalization + conformance fixtures (a tiny sample Maven/Gradle project with known-good and deliberately-broken tests). A few hundred lines total, and a natural first dogfooding candidate.

## Adapter Lifecycle — Built / Pinned / Never Per-Change

- **Built (before your project exists):** adapters are standalone versioned packages (`crucible-adapter-pytest`) from a registry. First-party ones ship from Crucible; community adapters gain certification by passing the conformance suite. Projects never compile or author adapter code.
- **Installed + pinned (during `crucible init`):** `init` runs `detect` ("Found pyproject.toml + pytest.ini → python-pytest v1.4.2 — pin it?"), writes the runner-to-adapter config (+ path globs for polyglot repos) into crucible.yaml and the **version + content hash into the lockfile** — the security-relevant moment: the binary running in CI must hash-match the pin, which is what makes adapters TCB rather than a bypass vector. `init` ends with a smoke `resolve` so misconfiguration surfaces immediately.
- **Per-change: nothing, deliberately.** Bindings only *reference* runners; a binding naming an unclaimed runner is a propose-time schema error, not a configuration opportunity. Post-init adapter events are explicit: `crucible adapter add` (new language enters the repo) and `crucible adapter upgrade` (re-hashes the lockfile — and because the lockfile is inside the approval-hash scope, an upgrade mid-change invalidates in-flight approvals, correctly: the judges' execution environment changed).

**Consequence worth naming:** `init` is the *only* interactive setup ceremony in the framework, and everything it produces — adapter pins, risk globs, model routing, notify hooks, CI workflows, context files, the schema bundle — is committed files. A teammate cloning the repo runs nothing; **the configuration is the repo.**

---

# Configuration & Reviewer Law (settled)

## Three Config Layers — One Owner, One Protection Level Each

| File | Contains | Committed? | Protection |
|---|---|---|---|
| `crucible.yaml` | **Enforcement only:** concrete policy, adapters, suites, AI-review mode | Yes | **Target-branch evaluation** |
| `.crucible/settings.yaml` | Team convenience: installed agent-tool surfaces and team notify channels | Yes | Normal change flow; never enforcement |
| `.crucible/local.yaml` | Personal notify/tool convenience | No (gitignored) | None needed — cannot affect merge |

**Boundary test (mechanical):** if editing it could change what merges, it goes in crucible.yaml; otherwise it cannot go there. Combining enforcement with notifications or personal tool settings would let convenience affect merge policy and would put personal settings in commits.

## crucible.yaml — Reference Shape

```yaml
policy:
  maximum_diff_lines: 500
  protected_paths:
    - ".github/workflows/**"
    - ".crucible/framework.lock.json"
    - ".crucible/adapters.lock.yaml"
    - "openspec/schemas/**"
    - "crucible.yaml"

adapters:
  java-junit: { runners: [junit], paths: ["**/*.java"] }

suites:
  unit: "mvn test"             # the project's standard invocation, recorded at init

verification:
  require_local_verify: true

ai_review:
  mode: off                    # off | advisory | required
```

## The Target-Branch Rule

**CI evaluates enforcement config from the branch being merged *into*, never from the PR branch.** One-sentence mental model: *the rules that judge you are the rules already on main.* Consequences:

- An agent or human editing policy in a PR achieves nothing for that PR — the edit only becomes law after it independently merges.
- Team config updates on main apply **instantly to all open PRs** — new risk knowledge isn't blocked by stale per-change seals (the flaw of hash-covering config).
- Known costs, accepted: local `verify` reads the working tree, so on a config-editing branch local behavior may differ from CI's — `status` prints "config differs from main; CI judges by main's rules." A rule change takes effect for subsequent PRs, not itself.
- Convenience files are exempt by construction: read from the working tree, incapable of affecting enforcement.
- The framework/verifier and adapter pins are target inputs too. A candidate pin edit cannot select the judge for that candidate.
- Enforcement-grade GitHub transport uses a ruleset-required trusted workflow or a future expected-source GitHub App. A repository-local workflow without that protection is labeled advisory by `doctor --ci`.

## .crucible/rubric.yaml — The Reviewer's Law

**Semantics:** rubric lines are *operationalized* tenets, not aspirations. The discipline is the `evidence:` field — every line must define what observable evidence constitutes a finding, or it cannot be adjudicated and becomes a vibes-veto. "Code should be maintainable" is a value; "unreachable code or disabled lint suppressions in the diff" is a rubric line.

**Shipped default (12 lines):**

```yaml
version: 1
lines:
  - {id: R-001, severity: block,  criterion: "Vacuous or tautological test assertions",
     evidence: "an assertion that passes regardless of implementation behavior"}
  - {id: R-002, severity: block,  criterion: "Weakening in oracle-measured paths",
     evidence: "widened tolerances, loosened conditions, or relaxed checks in code an oracle exercises"}
  - {id: R-003, severity: block,  criterion: "Silently swallowed errors",
     evidence: "caught exception with no handling, logging, or propagation"}
  - {id: R-004, severity: block,  criterion: "Unjustified new dependency",
     evidence: "dependency added without mention in the approved design"}
  - {id: R-005, severity: block,  criterion: "Concurrency hazard",
     evidence: "shared mutable state without synchronization on a concurrent path"}
  - {id: R-006, severity: block,  criterion: "Embedded secrets or environment-specific values",
     evidence: "credentials, tokens, or hardcoded env URLs in the diff"}
  - {id: R-007, severity: block,  criterion: "Decision the approved spec does not determine",
     evidence: "behavioral choice not derivable from spec delta or archived spec, and no escalation filed"}
  - {id: R-008, severity: block,  criterion: "Spec contradiction outside oracle coverage",
     evidence: "code behavior contradicting spec prose where no oracle measures it"}
  - {id: R-009, severity: block,  criterion: "Timing hacks to satisfy tests",
     evidence: "sleeps, retries, or ordering tricks whose purpose is making a test pass"}
  - {id: R-010, severity: advise, criterion: "Dead code or disabled checks",
     evidence: "unreachable code, commented-out logic, or disabled lint/type suppressions"}
  - {id: R-011, severity: block,  criterion: "Missing validation at trust boundaries",
     evidence: "external input reaching logic without validation on a new/changed path"}
  - {id: R-012, severity: block,  criterion: "Out-of-scope changes",
     evidence: "diff hunks unrelated to the approved proposal's scope"}
```

**Growth — two channels:** (1) your project's ratchet adds lines from postmortems and promoted observations; (2) the framework's shipped defaults evolve across Crucible versions from community learnings — `crucible doctor` offers new upstream lines **as a diff you accept or skip, never silently merged** (your law, your TCB).

**Generic vs. project-specific — deliberately both, and the specific ones are the valuable ones.** Defaults are generic by necessity; ratchet-added lines are usually business-specific ("monetary amounts are never computed in floating point"; "every query on shared tables filters by tenant ID"; "webhook payload fields are never removed, only deprecated"). rubric.yaml becomes the executable form of institutional knowledge — what senior reviewers carry in their heads today. Two disciplines keep it healthy:

- **Self-containment:** the reviewer is stateless with no memory of your postmortems — each line carries whatever business context it needs to be judged from diff + spec alone.
- **Placement ladder** (before anything becomes a rubric line): can it be an oracle/regression test? (best — deterministic, executable). A static or architecture rule? (next). Only if catching it genuinely requires semantic judgment does it belong in the rubric. **The rubric holds only what judgment alone can catch; everything mechanizable goes to a stronger home first.**

## Verdict Schema & the Enumerated-Blocking Rule

```json
{
  "change": "partial-refunds",
  "reviewed_sha": "9f3ab21",
  "rubric_hash": "sha256:…",
  "model": "…",
  "verdict": "fail",
  "findings": [
    { "rubric": "R-002", "severity": "block",
      "evidence": { "file": "src/payments/RefundService.java", "line": 141,
                    "excerpt": "if (Math.abs(total - captured) < 0.05)" },
      "explanation": "Tolerance widened from exact comparison; ORC-refund-002 measures this path.",
      "remediation": "Restore exact comparison; use BigDecimal equality per design.md §3." }
  ],
  "observations": [
    { "note": "Refund idempotency under webhook retry is untested — candidate for a new oracle." }
  ]
}
```

**Fail-closed rules (mechanical):** malformed JSON → fail; `verdict: fail` with zero block-severity findings → fail (inconsistent); a finding citing a rubric ID absent from the pinned rubric → fail (**the reviewer may not invent rules**).

**Enumerated-blocking:** the reviewer can *block* only on rubric lines. Anything else it notices goes to `observations` — attached to the PR, surfaced in the audit digest, promotable to rubric lines by humans via the ratchet. Rationale: the reviewer is the framework's one nondeterministic gate; open-ended veto means merge outcomes drift with model versions and phrasing, blocks become unfalsifiable, and the implement agent can't learn the rules it's judged by. Enumerated-only keeps what-can-stop-a-merge a fixed, versioned, human-owned list, while the model's ability to notice novel problems is harvested rather than discarded. Honest cost: the *first* instance of a genuinely novel failure class can merge if nothing else catches it — the identical bet the ratchet makes everywhere (one escape per novel class, permanent coverage after), narrowed further by static checks overlapping the worst categories and by human eyes on critical-tier PRs reading observations.

---

# Worked Examples — Three End-to-End Flows

> **Historical P2/P3 examples.** Their tier, routing, post-merge archive, and
> always-required reviewer details are parked. The normative Phase 4R example
> and acceptance sequence are in `docs/design/phase-4r-reset.md` §§1–11 and
> P4R-13/P4R-14. These examples remain only as feature/oracle design evidence.

## Example 1 — Standard feature: "Lock accounts after 5 failed logins"

```
$ crucible propose "lock account after 5 failed login attempts, 15-min cooldown"
```
The propose agent reads current specs and generates the bundle under `openspec/changes/account-lockout/`: proposal, spec delta (three SHALLs), design, and oracles.md — e.g. `ORC-lockout-001: Given 4 failed attempts, When a 5th fails, Then account is locked`, each bound to a real test it also writes (`tests/auth/test_lockout.py::test_fifth_failure_locks`). Plus the honesty sections: *Unspecified* ("does a successful login reset the counter? assumed yes") and *Seams* ("session service; notification contract").

```
$ crucible status
  change: account-lockout   tier: standard (computed: spec delta present, no risk paths)
  ✓ proposal ✓ spec-delta ✓ design ✓ oracles (7, all bindings resolve)
  ✗ approval — next: crucible approve
```

**The one human moment (~10 min):** `crucible approve` renders scenarios and bound tests side-by-side. The *Unspecified* section surfaces a real decision (successful login shouldn't fully reset a flagged account) — you edit the scenario inline; the tool regenerates the bound test, shows the diff, you confirm. `approval.yaml` seals content-hashes of everything reviewed. Last human touchpoint unless something routes back.

**Autonomous:** `crucible implement` refuses without approval.yaml → finds it → generates tasks.md first → fresh-context agent codes red-to-green against local `verify` (advisory, regression scoped for speed) → pushes.

**CI (the authority):** re-runs verify in full — all oracles, unit + *complete* regression suite, traceability lint, approval-hash + oracle-immutability checks, trajectory checks (local verify was actually run; no attempted oracle-path writes), static suite, adversarial reviewer (pass), tier recomputation (standard, no risk globs) → **auto-merge**. Archive folds the spec delta into specs/; the 7 oracles join the permanent regression suite.

*You wrote zero code and read zero code. You read 7 scenarios and fixed one.*

## Example 2 — Pure refactor: "Extract retry logic into a shared module"

```
$ crucible propose "extract duplicated retry logic from payment + email clients into shared util"
```
Type infers to `refactor`: **no behavior change → no spec delta → no new oracles.** The bundle is thin (one-paragraph proposal + short design note); tier computes to *trivial*. Approve takes a minute: "moving code, promising nothing new."

The correctness criterion *is the accumulated regression suite*: every past oracle must still pass with the spec untouched. Trivial tier skipped *authoring ceremony*, not *executed checks* — CI runs the full regression suite, static suite, and reviewer as always. If the refactor subtly changes retry timing some past oracle pinned → red, routed back. The tier claim is safe against gaming: recomputed from the diff at approve, implement, and CI (a "trivial" claim touching `payments/**` fails). Honest residual: behavior no past oracle ever pinned can drift — a coverage gap for the ratchet.

*This is the maintenance unlock: the "too risky to touch" refactor is safe because every past promise is executable.*

## Example 3 — Critical path with mid-flight ambiguity: "Partial refunds"

```
$ crucible propose "support partial refunds on orders"
```
Touched paths match `payments/**` → tier computes **critical**: deeper proposal, 12 scenarios including property tests ("sum of partial refunds never exceeds captured amount"), and the seams section flags the ledger service and the merchant-facing webhook contract. You review carefully — this is what the gate exists for. Critical tier requires per-oracle test acknowledgment. Sealed.

**Mid-implementation the agent hits ambiguity** — fee handling on partial refunds isn't derivable from the spec. It does not improvise: it runs `crucible escalate`, which writes escalation.yaml and ends the run (implement cannot resume while it's unresolved). Your Slack notify hook fires.

```
$ crucible status
  ⚠ ESCALATION: ORC-refund-007 underspecified — fee handling on partial refund
    options: (a) proportional recalc  (b) no fee refund  (c) flat re-fee
  next: crucible amend
```

`crucible amend`: you pick (a); the agent patches the spec delta + affected oracle + bound test; you see exactly that diff; a delta entry with fresh hashes is appended to approval.yaml. Thirty seconds. The ambiguity now lives permanently in the spec, not in one agent's head.

**CI:** everything from Example 1, plus **blocking diff-scoped mutation testing** (critical tier). One mutant survives — the reviewer's verdict cites the rubric line and points at a vacuous assertion; the implement agent fixes it next iteration. All green — but critical tier means **no auto-merge**: the PR routes to you with the diff, covering oracles, reviewer notes, and mutant history. You review *this one* because the router decided it matters.

**Two weeks later** a customer hits an escaped edge case (refund against a disputed charge — discovered via support/ops, as today). The fix is itself a Crucible change of type `bugfix`, whose schema *mechanically requires* a reproduction oracle, verified red-on-base/green-on-fix by CI. The fix cannot merge without permanently encoding the failure mode: `ORC-refund-013` joins the regression suite, and *that reproduction* can never regress silently again.

## The pattern

Your commands are `propose → approve → implement`, plus `amend` when reality bites. Tier computation, hashing, routing, and the gauntlet happen *to* the change, not *by* you. State never lives in anyone's head: `crucible status` derives it from the artifacts on disk, always ending with the exact next command.

---

# V1 vs. V2 — Side-by-Side

| Dimension | V1 | V2 | Why DX is better |
|---|---|---|---|
| **Mental model** | Novel bespoke system: work orders, gauntlets, protected-path approval commits | Extended TDD/BDD: explore → propose → approve → implement → verify | Maps onto workflows developers already know (and onto OpenSpec's existing command shape); near-zero onboarding vocabulary |
| **Human involvement per feature** | Author spec (agent-assisted), author/review oracles as a separate pre-implementation step, approve via protected-path commit, review risk-routed PRs, resolve escalations | **One gate:** review the propose bundle (spec + oracles + scope) in a single sitting; then only risk-routed PRs | Multiple ceremonies collapse into one focused review of declarative artifacts; ~80% of the guarantee for ~10% of the friction |
| **Oracle authorship** | Human authors oracles by hand before implementation | Propose agent drafts oracles; human reviews/edits at the gate; immutable after approval | Removes the biggest human bottleneck without reintroducing the fox-guards-henhouse problem — the gate + hash + immutability check preserve the trust property |
| **Spec completeness attack** | Implicitly the human's burden when authoring | Propose agent must emit an explicit "unspecified / out-of-scope" section; BDD scenarios reviewed by recognition, not recall | Ambiguity is surfaced *to* the human instead of expected *from* the human |
| **Workflow enforcement** | Branch protection, CODEOWNERS-protected paths, work-order manifests, approval commits — mandatory for everyone | Content-hash approval artifact verified in CI; platform hardening optional per team size | Same tamper-evidence, a fraction of the platform ceremony; solo devs and small teams get the guarantee without GitHub org configuration |
| **Local development** | The loop runs through infrastructure end-to-end; iteration implicitly gated | Local `verify` is a fast advisory feedback loop; enforcement deferred to CI | Developers iterate at TDD speed; the framework never blocks a local edit-run cycle |
| **CI cost** | Full Gauntlet incl. mutation testing on every PR | Pruned gate set; mutation testing diff-scoped, blocking only on risk paths, async elsewhere | Dramatically faster PR turnaround with equivalent protection where it matters |
| **Tooling surface** | Custom framework built from scratch | Layer over OpenSpec artifact conventions + standard GitHub Checks | Familiar directory layout, existing ecosystem/slash-command integrations, less code to trust (smaller TCB) |
| **Interface** | Work-order packaging, manifests, iteration budgets exposed to the user | Five stateless CLI commands with clean boundaries; preconditions produce clear "run X first" errors | The state machine still exists — it's just invisible; errors teach the workflow instead of documentation |
| **Rigidity** | Phase-locked; going around the loop structurally prevented | Same invariants, but explore is optional, propose is iterable pre-approval, and only the approval boundary is hard | Flexibility where it's safe (before approval), rigidity only where it buys trust (after) |

### The one-line summary

**V1 proved the trust model; V2 makes it something developers will actually want to run.** Same invariants — oracles precede code, artifacts gate progression, CI is the only authority, the ratchet only tightens — delivered through one human gate, five commands, and a local loop that feels like TDD.

---

# Build Plan (settled)

## Foundational build decisions

- **Agent authoring surfaces:** `init` renders provider-neutral Crucible workflows into Codex and Claude Code skills/commands. They run in the user's active session and drive the project-local CLI. The CLI never invokes an agent or selects an agent sandbox/model for authoring.
- **Agent entry surfaces, one engine:** the CLI is always the substrate of record. Optional editor, slash-command, or future skill wrappers only drive it. Interactive agents distill decided intent into `crucible propose`; command-invoked roles start fresh. `approve` remains a human act on every surface.
- **Implementation language:** TypeScript/Node — same ecosystem as OpenSpec, npm-ready later, appropriate for an orchestration-heavy/compute-light tool.
- **Repo layout:** monorepo — `core/`, `schemas/`, `adapters/stub/`, `adapters/java-junit/`, `fixtures/`, `ci-templates/` — so the protocol and its consumers version together while fluid.
- **Framework before adapter**, via a **stub adapter**: a trivial executable implementing `resolve`/`run` over a toy fixture repo (≈1 day; doubles as the conformance-suite seed). `java-junit` is built only after the protocol survives contact with the core.
- **Dogfooding: declined.** Compensating discipline: Crucible's own repo is the TCB of every project built with it, so its correctness-critical parts (hashing, traceability lint, tier computation, verdict parsing) get real test coverage the old-fashioned way. The first project — not self-hosting — is the validation instrument.
- **First project (validation instrument):** a production-grade Java + Spring Boot consumer product, built end-to-end with Crucible. Its shape informs early choices (e.g., Testcontainers-heavy integration tests → adapter and CI templates plan for them from the start).

## Phases (tracer-bullet order: one thin slice end-to-end first, then deepen)

**Phase 0 — Spike & scaffold (~days):** install a custom OpenSpec schema bundle for real; confirm artifact ordering via `requires`; pin the supported OpenSpec version range. Scaffold the monorepo + stub adapter + toy fixture repo.

**Phase 1 — Tracer bullet (weeks):** minimal `propose → approve → implement → verify` on a toy change through the stub adapter, plus `status` and a minimal CI check that re-runs verify. Every stage exists in thin form: propose emits a valid bundle, approve writes real hashes, implement runs a real headless agent, verify parses real adapter output. Crucible is demonstrable at the end of this phase.

**Phase 2 — Deepen the loop:** full traceability linter; tier computation + routing; amend/override/escalate; change-type schemas (feature/bugfix/refactor incl. red-on-base/green-on-fix); adversarial reviewer + rubric + verdict parsing; trajectory session-log capture; notify hooks; `crucible why`; the approve review surface (backlog A3); `doctor` + CI-template maintenance.

**Phase 3 — Real adapter:** conformance fixtures (Maven + Gradle sample projects, known-good and deliberately-broken) → `java-junit` (detect, run via JUnit XML, resolve via Launcher-API helper; scope skipped) → stub retired to the conformance suite.

**Phase 4 — Validation experiment (halted):** Spring/Notes dogfooding exposed that reactive session, review, CI-authority, upgrade, and archive recovery mechanisms had displaced the ordinary product workflow. The final state is preserved as evidence, not a release.

**Phase 4R — Framework reset:** restore the stable pre-expansion tree; rebuild the OpenSpec-like active-session skills, terminal-only approval, deterministic verify, complete pre-PR archive, retained distribution/adapter fixes, and trusted CI from named red consumer tests.

**Phase 5 — Fresh validation:** only after generic and Spring Phase 4R lifecycles and a manual UX walkthrough are green, validate a new production consumer and collect release evidence.

## Success criteria — headline + instruments

**Headline:** a production-grade, consumer-ready product shipped end-to-end through Crucible.

**Instruments** (recorded from approval artifacts, Git, and CI rather than committed workflow state): gate-review minutes · amendment count/time · local and CI verify latency · deterministic failure causes · archive/submit friction · human minutes per merged change · escaped defects. At project end these numbers, plus the executable consumer matrix, decide whether Crucible delivers conserved verification effort with better DX.

**Explicit v2.0 non-goals:** everything in Backlog Category C (hermetic sandboxing, harness eval suite, trajectory checks phase 2, merge-queue scaling, native non-test runners, canary/SLO, org hardening) and Category D (further adapters, community certification, distribution).

---

## Backlog

### Settled log (for the record)
Oracle artifact schema & binding spec · naming (Crucible, oracles) · three config ownership layers + target-branch rule · adapter protocol core · human approval hashes · amendment/re-seal · OpenSpec integration · one-rich-gate TDD resolution · Phase 4R CLI/skill separation · complete pre-PR archive · deterministic verify versus optional AI review.

Historical tier, override, committed-state, trajectory, mutation, routing, and ratchet designs are parked inputs, not active reset contracts.

### A. Remaining design decisions (small, concrete)
1. Adapter capability taxonomy — finalize the enum (`unit`, `property`, `contract`, `integration`, `mutation`, `arch-rules`, `sast`, `scope`, ...) and the tier/route → required-capability mapping.
2. Conformance-suite fixtures — the sample Maven/Gradle fixture repos (known-good + deliberately-broken tests) that certify adapters; needed before or alongside the `java-junit` build.
3. Approve review surface — the flagship experience: how the bundle renders (terminal UI vs. local web view vs. markdown-in-editor), side-by-side scenario/test layout, inline edit-and-revalidate flow, per-oracle acknowledgment UX for critical tier.
4. Propose/implement/review prompt engineering — the actual contents of `.crucible/context/*.md` (role prompts, escalation rule, seams/unspecified section templates, static/dynamic boundary file).
5. Mutation-testing tool selection for the JVM (likely PIT) and its diff-scoping mechanics.
6. Stacked-change plan mechanics — how propose declares a stack, how per-entry diff caps and approvals interact.
7. Weekly audit digest — sampling mechanism, delivery format, how observations and async mutation results feed it.
8. `crucible why` — failure→oracle→adapter→tool-output trace implementation.
9. Override automation — the ratchet-issue filing flow and the retroactive-proposal linkage.

### B. Build plan — **settled** (see Build Plan section)
10. ~~MVP scoping & build order~~ — settled: full-framework scope, tracer-bullet phases 0–4, framework-before-adapter via stub.
11. ~~Dogfooding plan~~ — settled: declined; compensated by real test coverage on Crucible's correctness-critical core; the first project is the validation instrument.
12. Distribution — **deferred by decision** until the system is validated by a few built projects (npm vs. binary, adapter registry, release process).
13. ~~Success criteria~~ — settled: headline (production-grade product end-to-end) + recorded instruments.
14. ~~OpenSpec compatibility testing~~ — folded into Phase 0 spike (pin version range; `doctor` behavior lands in Phase 2).

### C. Hardening milestones (parked deliberately; revisit post-MVP)
15. Hermetic CI sandboxing — containers, pinning, network restriction; until then hashing/immutability carry tamper-evidence.
16. Harness regression eval suite — fixture diffs with known verdicts for the reviewer (re-run on model/rubric change); "set the bar at the eval, not the demo."
17. Trajectory checks phase 2 — session-log capture ships in v2.0; the deterministic checks over it (local-verify-was-run, attempted-TCB-writes, budget) land next.
18. Regression-suite scaling — scoped-on-PR + full-on-merge-queue once full-suite CI time hurts.
19. Native non-test runners — `sql-constraint`, `arch-rule` adapters (v2.0: everything-is-a-test).
20. Canary/SLO integration — deploy hooks that auto-file ratchet issues from production signals, closing the ops→ratchet loop without human memory.
21. Platform hardening for larger orgs — optional CODEOWNERS/branch-protection layers atop the hash mechanisms.
22. Review-model enforcement — promote reviewer-model identity from verdict-pinned/audit-flagged to enforcement config if drift proves real.

### D. Ecosystem (post-launch)
23. Python/TypeScript reference adapters (after `java-junit`).
24. Community adapter certification process around the conformance suite.
25. `generic-command` escape-hatch adapter (hashed config, loud tier/routing downgrade).
26. Upstream rubric-line distribution channel via `crucible doctor`.
