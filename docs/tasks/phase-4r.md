# Tasks — Phase 4R Reset

> **Status: ratified 2026-08-24.** P4R-00 and P4R-01 establish the design and
> historical reset boundary.  P4R-02 onward are pending and execute strictly in
> dependency order.  Test-first and commit-at-every-green-step remain law.

Each task is one focused session unless its own delivery protocol explicitly
separates a design commit from implementation.  Done means every named
acceptance test passes, required consumer evidence is non-skipped, and the work
is committed.

## Foundation

### P4R-00 · Ratify reset constitution

Tier: Fable / Sol

Depends: human review of Phase 4 lessons

Reads: `docs/charter.md` premise/workflow/OpenSpec/approval/verify/target-branch
sections; `docs/p4-lessons.md`; `AGENTS.md` invariants.

Delivers: `docs/design/phase-4r-reset.md`, this task ledger, Phase ledger and
charter/architecture/AGENTS amendments that make the reset rules unambiguous.

Acceptance:

- the ten ratified principles appear normatively and do not conflate
  deterministic `verify` with `ai-review`;
- Phase 4 is recorded as halted, Phase 4R as active, and Phase 5 as blocked on
  the reset exit;
- conflicting P4 runtime contracts are explicitly superseded or parked;
- documentation links and formatting checks pass.

Status: complete when the reset-foundation documentation commit lands.

### P4R-01 · Preserve P4 evidence and establish reset baseline

Tier: Opus / Terra

Depends: P4R-00 decision

Reads: `docs/p4-lessons.md` Reset rule; repository history from `e32afd9` to the
preserved P4 tag.

Delivers: archival branch/tag for the final P4 state and one explicit reset-tree
commit on `codex/v2-reset` whose tracked tree starts at `e32afd9`.

Acceptance:

- `codex/p4-experimental-archive` retains the final uncommitted P4 evidence;
- tag `p4-experimental-final-2026-08-24` resolves to that archival state;
- reset commit `1880e3e` has current main as ancestry but a tracked tree equal
  to `e32afd9` before Phase 4R documentation;
- no force-push, history rewrite, or loss of user files occurs.

Status: complete (`aaff6cf`, tag, and `1880e3e`).

## Thin local lifecycle

### P4R-02 · CLI engine and generated skill boundary

Tier: Fable / Sol design verification + Opus / Terra implementation

Depends: P4R-01

Reads: Phase 4R §§2–3; charter workflow and DevEx principles; architecture §§1–6;
OpenSpec skill/command generation behavior recorded in the Phase 4R design.

Delivers: one provider-neutral workflow definition rendered into supported
Codex and Claude skill/command surfaces; stateless CLI scaffold/instructions/
status APIs; removal of command-layer agent invocation from the ordinary path.

Acceptance:

- installed propose/implement/verify/amend/archive/status wrappers call only the
  project-local pinned CLI and operate in the active agent session;
- no wrapper or ordinary CLI command invokes `codex exec`, `claude -p`, an
  `AgentSubstrate`, or another agent;
- interrupted work resumes from artifact-derived `status` with no session file;
- forged conversation text or cache files cannot unlock a transition;
- init/update are idempotent and preserve human-owned instruction bytes.

Non-scope: headless automation, AI review, proposal semantics, CI transport.

### P4R-03 · Proposal, custom artifacts, and oracle-test validation

Tier: Fable / Sol contract + Opus / Terra implementation

Depends: P4R-02

Reads: Phase 4R §§3–4; charter Oracle Artifact, OpenSpec Integration, Traceability,
and adapter binding sections; architecture §§7–9.

Delivers: propose skill/CLI flow that authors every schema-required pre-approval
artifact and real bound tests; schema-derived approval candidates; strict
`found|missing` adapter resolution with no `candidateFile`.

Acceptance:

- a valid generic proposal and Java proposal reach `ready-for-approval` only
  when all required/custom artifacts exist and every binding is collected and
  grounded to a contained test file;
- missing/ambiguous/unsupported/outside-root targets and malformed adapter JSON
  fail closed with an actionable revise instruction;
- the agent may choose a conventional test path without CLI path authorization;
- new feature and bugfix oracle tests satisfy the specified red-on-base rule;
- `tasks.md` before approval is rejected;
- legacy session/checkpoint/candidate-file types have no production reference.

Non-scope: approval writes, implementation, adapter classpath enhancements.

### P4R-04 · Terminal-only approval and schema-derived seal

Tier: Fable / Sol review UX + Opus / Terra implementation

Depends: P4R-03

Reads: Phase 4R §5; charter Core Inversion, Approve Session, and hash contracts;
architecture §§4, 8–9.

Delivers: interactive `crucible approve <change>` that revalidates, renders all
schema-declared approved artifacts and grounded oracle tests, and writes a
strict content seal only after explicit terminal confirmation.

Acceptance:

- decline writes nothing; non-interactive use requires an explicit safe flag
  and reviewer identity;
- all pre-approval custom artifacts and every grounded bound test enter the
  deterministic hash scope;
- missing, stale, malformed, or uncollected content prevents approval;
- modifying one sealed byte voids approval;
- no skill, agent message, convenience file, or generated task can mint a seal.

Non-scope: tier ceremony, override, implementation.

### P4R-05 · Implement skill and deterministic local verify

Tier: Opus / Terra

Depends: P4R-04

Reads: Phase 4R §6; charter Three Kinds of Tests and How Verify Executes;
architecture adapter, hashing, and report contracts.

Delivers: active-session implement skill, post-approval `tasks.md`, strict
preflight, and credential-free deterministic verify over current oracles,
archived regression oracles, declared suites, traceability, seals, and pins.

Acceptance:

- missing/void approval blocks before any implementation instruction;
- implementation may change code and ordinary tests but sealed artifacts or
  oracle-test edits are red;
- oracle `skip`, missing results, suite failure, malformed output, or adapter
  drift is red;
- unit/build/lint/typecheck suite failures are attributable;
- same inputs produce byte-stable machine reports;
- an agent self-review message cannot turn a red report green.

Non-scope: CI authority, AI review, amendment, archive mutation.

### P4R-06 · Intent amendment and human re-seal

Tier: Fable / Sol contract + Opus / Terra implementation

Depends: P4R-05

Reads: Phase 4R §7; charter Approval/Amend and Editing Artifacts sections;
architecture artifact/hash contracts.

Delivers: amend skill for approved intent/oracle changes plus terminal-only
`crucible approve --amend <change>` that shows the approved-to-current delta and
appends a new seal generation.

Acceptance:

- ordinary code/test fixes require no amendment;
- a direct sealed edit blocks implement/verify until an amendment is validated
  and human re-sealed;
- dependent custom artifacts and bound tests are revalidated together;
- decline leaves the old approval authoritative and the change blocked;
- no session checkpoint, child agent, or agent-authored approval exists;
- amendment history is deterministic and preserved by archive.

Non-scope: override, escalation automation, tier changes.

### P4R-07 · Atomic schema-complete archive

Tier: Fable / Sol filesystem contract + Opus / Terra implementation

Depends: P4R-05, P4R-06

Reads: Phase 4R §8; charter OpenSpec Integration and regression semantics;
OpenSpec archive behavior pinned for the supported runtime.

Delivers: pre-PR archive that revalidates, syncs specs, and atomically moves the
entire change directory while retaining permanent bound-test regression.

Acceptance:

- proposal, specs, design, `oracles.md`, `tasks.md`, approval/amendments,
  `.openspec.yaml`, every schema extension artifact, and unknown extra files are
  preserved byte-for-byte;
- every pre-approval custom artifact was sealed before archive;
- spec deltas sync exactly once and the complete directory moves to the
  canonical dated archive path;
- bound oracle test code remains in the product suite and is discovered as
  regression input;
- validation, sync, collision, permission, or filesystem failure rolls back
  without a partial archive;
- a freshly archived change can be submitted in the same feature PR; no
  archive-only lane is required.

Non-scope: post-merge archive recovery and framework upgrades.

## Retained platform capabilities

### P4R-08 · Project-local framework distribution

Tier: Fable / Sol packaging contract + Opus / Terra implementation

Depends: P4R-07

Reads: Phase 4R §9; Phase 4 lessons retained distribution evidence; Phase 0
OpenSpec pin notes; architecture module/config contracts.

Delivers: exact project framework pin and launcher, packaged supported OpenSpec
runtime, built-JavaScript workspace exports, deterministic install/update, and
doctor checks without ambient executable fallback.

Acceptance:

- a clean Java-only consumer with no npm project can init/propose/archive from
  the project-local distribution;
- launcher rejects missing, mutable, mismatched, or unreachable pins and never
  consults an ambient `crucible` or `openspec`;
- plain supported Node runs only built JavaScript; missing build output fails;
- install/package output is byte-stable and doctor detects drift;
- no P4 session, authority, posture-bootstrap, or reviewer code is reintroduced.

Non-scope: updating an initialized pin, target-owned CI, adapter classpaths.

### P4R-09 · Java/JUnit dependency-backed adapter boundary

Tier: Opus / Terra

Depends: P4R-03, P4R-08

Reads: Phase 4R §9; Phase 3 adapter design/conformance; Phase 4 lessons on the
Spring MockMvc discovery failure; architecture §7.

Delivers: narrowly ported Maven and Gradle dependency-backed discovery inside
the adapter, preserving the frozen `resolve`/`run` core protocol and
reproducible package.

Acceptance:

- Maven Spring MockMvc and Gradle dependency-backed targets resolve with exact
  grounded files using evaluated test classpaths;
- resolve may compile/resolve dependencies but executes no test body;
- build-tool, model, classpath, helper, linkage, and malformed-output failures
  abort instead of degrading to missing;
- genuine absent targets remain `missing`, with no `candidateFile`;
- Maven/Gradle conformance, malformed transport, and twice-built package hash
  suites are green.

Non-scope: framework lifecycle, Spring-specific core logic.

### P4R-10 · Target-owned deterministic CI verification

Tier: Fable / Sol security design gate + Opus / Terra implementation

Depends: P4R-07, P4R-08, P4R-09

Reads: Phase 4R §10; charter Target-Branch Rule; GitHub required-workflow,
ruleset, check-source, `pull_request`, `pull_request_target`, and merge-group
security documentation; AGENTS invariants.

Delivers: explicit base/candidate trust partition; preferred organization-
ruleset required workflow using the ordinary restricted `pull_request` event;
exact base config/framework/adapter inputs; required deterministic `verify`;
and an honest protection-grade diagnostic.

Delivery protocol: land the threat model and red executable workflow tests
before selecting or implementing transport.  If GitHub evidence contradicts
the preferred design, stop for a design amendment.

Acceptance:

- candidate edits to config, verifier pin, adapter pin, workflow, or historical
  harness cannot affect that candidate's evaluation;
- exact base/head binding, same-repository and fork heads, and merge queue
  events are covered;
- candidate execution receives no secret, write token, persisted checkout
  credential, privileged cache, or persistent runner;
- required workflow absence/failure cannot be replaced by a same-name candidate
  job;
- `doctor --ci` distinguishes enforcement-grade ruleset/App protection from an
  advisory repository-local workflow;
- `pull_request_target` candidate execution is rejected by default and remains
  an explicit TODO unless a separately ratified proof bounds it;
- missing required-workflow support yields the chosen honest fallback, never a
  false enforcement claim.

Non-scope: AI review and framework-update UX.

### P4R-11 · Optional independent AI review

Tier: Fable / Sol policy + Opus / Terra implementation

Depends: P4R-10

Reads: Phase 4R §11; charter rubric/verdict law as historical input; target-
owned CI trust partition; official credential-isolation guidance.

Delivers: strict `off|advisory|required` AI-review configuration and independent
schema-validated review transport that cannot change deterministic verify.

Acceptance:

- default/off performs no model call and needs no API key;
- advisory runs only with configured credentials and never blocks merge;
- required fails on absent credentials, unavailable transport, malformed/stale
  verdict, unknown rubric IDs, or valid blocking findings;
- candidate config cannot change its own review mode or rubric;
- implementing-session prose/local self-review is never reused as CI evidence;
- deterministic `verify` bytes and result are identical in all modes.

Non-scope: provider marketplace, model routing, automated ratchets.

### P4R-12 · Separate framework maintenance workflow

Tier: Fable / Sol root-of-trust contract + Opus / Terra implementation

Depends: P4R-08, P4R-10

Reads: Phase 4R §13; target-owned CI decision; Phase 4 upgrade/bootstrap failure
lessons.

Delivers: dedicated framework update command that stages only a new immutable
pin and deterministic managed bytes, renders the exact diff, and requires
explicit human confirmation outside product governance.

Acceptance:

- malformed/mutable/unreachable pins, dirty tracked input, declined approval,
  and partial writes fail or roll back;
- product, tests, OpenSpec changes, policy, schemas, adapters, skills, and
  unrelated bytes cannot mix with the maintenance transaction;
- the new framework never claims to have authorized itself and no fake product
  oracle is created;
- the selected required-workflow/App root evaluates or explicitly human-gates
  the transition;
- no legacy bootstrap/finalization/archive-recovery classifier returns.

Non-scope: automatic releases and registries.

## Executable exit evidence

### P4R-13 · Disposable generic consumer lifecycle

Tier: Fable / Sol acceptance

Depends: P4R-08, P4R-10, P4R-12

Reads: all Phase 4R design sections; every completed P4R as-built note.

Delivers: a clean real-Git generic/stub consumer that runs exact built candidate
bytes through the entire lifecycle and PR-shaped trusted verify.

Acceptance:

- one non-skipped test executes init → propose artifacts/custom artifact/oracle
  test → terminal approval → implement/unit tests → local verify → complete
  archive → required PR verify;
- missing approval, oracle drift, skip, unit failure, malformed artifact, direct
  trust edit, and incomplete archive are independently red;
- a second change runs against the first archived regression oracle;
- no API key, child agent, session checkpoint, or manual Crucible-byte edit is
  used;
- the exact command is recorded as a release blocker.

Non-scope: Java/JUnit and AI-review-required mode.

### P4R-14 · Spring/JUnit consumer and UX exit

Tier: Fable / Sol acceptance

Depends: P4R-09, P4R-10, P4R-13

Reads: all Phase 4R design sections; generic consumer evidence; Phase 3 Spring
fixtures; P4 failure lessons.

Delivers: disposable real-Git Spring Boot/Maven lifecycle using a dependency-
backed JUnit oracle, plus a manual Codex walkthrough and Phase 4R exit report.

Acceptance:

- the Spring consumer executes the same single-branch lifecycle as P4R-13,
  including real red-on-base/green-on-implementation oracle behavior and full
  archived regression on the next change;
- adapter discovery, packaging, target-owned PR verify, archive of all custom
  artifacts, and no-API-key mode run from exact built candidate bytes;
- JVM/tool/CI negative paths remain attributable and fail closed;
- the manual walkthrough starts with `crucible init`, uses the generated Codex
  skills, performs approval in a separate terminal, archives, and prepares one
  PR without undocumented commands or Crucible-byte edits;
- `docs/phase-4r-validation-report.md` records evidence and UX findings;
- PHASES marks Phase 4R done and authorizes Phase 5 only after every item above
  is green.

Non-scope: new product features, additional adapters, parked tier/routing/
override/trajectory/mutation systems.
