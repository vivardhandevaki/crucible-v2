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

P4R-10 is complete only when P4R-10A through P4R-10E are complete. The split
keeps the trust decision, GitHub transport, fallback offering, installation
diagnostic, and rejected privileged transport independently reviewable.

Delivery protocol: ratify P4R-10A and land its red executable trust-boundary
tests before implementing a transport. If current GitHub evidence contradicts
the preferred design, stop for a design amendment. AI review and framework-
update UX remain outside every P4R-10 subtask.

#### P4R-10A · Ratify the exact base/candidate trust partition

Tier: Fable / Sol security design gate

Depends: P4R-07, P4R-08, P4R-09

Reads: Phase 4R §10; charter Target-Branch Rule; architecture Phase 4R reset
contracts; GitHub check-source, ruleset, event-SHA, and merge-group security
documentation; AGENTS invariants.

Delivers: a threat model and executable trust-boundary contract that identify
the exact base commit `B`, candidate commit `H`, attacker capabilities, and the
origin of every verification input.

Acceptance:

- enforcement config, framework/verifier pin, adapter pins, historical oracle
  and harness inputs, and applicable reviewer policy/rubric are read from exact
  base commit `B`;
- product code, ordinary tests, and the proposed approved change and oracle
  tests are evaluated from exact candidate commit `H`;
- proposed edits to trust files are treated only as untrusted candidate data
  and cannot affect that candidate's result;
- same-repository heads, fork heads, base movement, stale event data, malformed
  SHAs, and merge-group commits have explicit fail-closed fixtures;
- red executable tests prove that substituting any base-owned input or either
  commit identity is rejected before P4R-10B transport work begins.

Non-scope: choosing credentials, AI review, and framework maintenance.

#### P4R-10B · Prove the organization-ruleset required workflow

Tier: Fable / Sol transport review + Opus / Terra implementation

Depends: P4R-10A

Reads: the P4R-10A threat model; official GitHub required-workflow, organization
ruleset, check-source, restricted `pull_request`, token-permission, fork, and
`merge_group` documentation.

Delivers: the preferred organization/enterprise required workflow, stored in
a separately trusted workflow repository, that runs deterministic `verify`
for ordinary PRs and merge queues using the ratified `B`/`H` partition.

Acceptance:

- the workflow checks out exact base and candidate commits separately, takes
  every trust input from `B`, and executes the candidate from `H`;
- candidate execution receives no secret, write token, persisted checkout
  credential, privileged cache, or persistent runner;
- same-repository and fork PRs run through the restricted ordinary
  `pull_request` path, and merge queues run through `merge_group`;
- the protected rule requires the expected workflow/check source, so a
  candidate job with the same display name cannot satisfy or replace it;
- missing, cancelled, stale, or failed required-workflow execution stays red;
- executable fixtures prove the happy path and each security boundary above.

Non-scope: repository-local enforcement claims and LLM credentials.

#### P4R-10C · Decide and deliver the non-organization offering

Tier: Fable / Sol product and trust decision + Opus / Terra implementation

Depends: P4R-10A, P4R-10B

Reads: P4R-10A/B evidence; GitHub App expected-source and repository-ruleset
capabilities; charter requirement for honest advisory labeling.

Delivers: a ratified decision between an expected-source GitHub App and an
explicitly advisory repository-local workflow, followed by the minimum
installable implementation and documentation for the chosen offering.

Delivery protocol: record the capability, operational, and security tradeoffs
before implementation. Choosing a GitHub App that expands the ratified trust
model requires a design amendment; choosing the local workflow must never call
it enforcement-grade.

Acceptance:

- repositories without organization required-workflow support receive one
  documented, installable offering rather than an implied protection level;
- a GitHub App path, if selected, proves expected check source, exact `B`/`H`
  binding, least privilege, and the P4R-10A trust partition;
- a repository-local path, if selected, labels its status and checks advisory
  because candidate-controlled repository configuration cannot grant merge
  authority;
- unsupported, partially installed, or misconfigured states fail closed and
  never report enforcement-grade protection.

Non-scope: a marketplace/catalog program or support for unrelated CI vendors.

#### P4R-10D · Add enforcement-grade `doctor --ci` diagnostics

Tier: Opus / Terra

Depends: P4R-10B, P4R-10C

Reads: P4R-10A trust grades; the installed organization workflow/App/advisory
contracts from P4R-10B/C; architecture diagnostic conventions.

Delivers: deterministic human and machine-readable `crucible doctor --ci`
output that reports the protection actually installed, with evidence and
actionable remediation.

Acceptance:

- valid expected-source required-workflow or App protection is reported as
  enforcement-grade only when every required rule, event, pin, and check source
  matches;
- repository-local candidate-controlled CI is reported as advisory even when
  its latest check is green;
- absent, inaccessible, partial, stale, spoofable, or malformed protection is
  distinguished from a valid installation and never upgraded by assumption;
- output identifies which required capability failed without exposing secrets,
  and identical observations produce byte-stable machine output;
- fixtures cover organization, App if selected, advisory, absent, and malformed
  states.

Non-scope: repairing remote rules without explicit human authorization.

#### P4R-10E · Reject default `pull_request_target` candidate execution

Tier: Fable / Sol security contract + Opus / Terra guardrails

Depends: P4R-10A

Reads: Phase 4R §10; GitHub `pull_request_target` security guidance; P4R-10A
attacker model; the P4R-10B/C selected transports.

Delivers: documented and executable guardrails that reject
`pull_request_target` as the default transport whenever candidate code or
candidate-controlled executable input would run in its privileged context.

Acceptance:

- generated templates and supported installation paths never execute candidate
  code through `pull_request_target`;
- configuration or workflow inspection reports such execution as unsupported
  and non-enforcement-grade;
- documentation retains an explicit TODO requiring a separately ratified,
  bounded threat model before any future exception;
- tests reject direct checkout, indirect script loading, artifact reuse, or
  other candidate-controlled execution in a privileged target context.

Non-scope: designing or approving that future exception.

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
