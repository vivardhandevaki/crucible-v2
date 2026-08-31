# Design — Phase 4R (Crucible V2 Framework Reset)

**Status: RATIFIED (P4R-00, 2026-08-24).** This design supersedes conflicting
Phase 4 experiments.  Phase 4 history remains preserved as evidence; no P4
runtime mechanism is inherited unless a task below explicitly ports it through
new failing acceptance coverage.

## 1. Objective and exit

Restore Crucible to its first-principles product: a thin, deterministic layer
over OpenSpec in which humans approve intent artifacts and oracle tests, agents
implement against sealed goalposts, and deterministic verification supplies
the evidence.

Phase 4R exits only when disposable generic and Spring/JUnit repositories both
complete the same branch-local lifecycle:

```text
init
  → propose skill authors artifacts and bound oracle tests
  → human terminal approval seals them
  → implement skill writes tasks, code, and ordinary tests
  → deterministic local verify is green
  → archive skill validates, syncs, and archives the complete change
  → a PR-shaped trusted verifier reruns deterministic checks
```

No API key is required for that lifecycle.  A manual UX walkthrough must show
that it feels like OpenSpec plus one explicit human approval gate.

## 2. Ratified principles

1. Crucible CLI commands never spawn Codex, Claude, or another agent.
2. Skills/custom commands run inside the user's existing agent session.
3. Skills may write files; only the CLI determines whether those files are
   valid.
4. Agent messages and conversation history have no authority.
5. Human approval is created only by an explicit terminal command outside the
   agent session.
6. Approved artifacts and bound oracle tests are sealed and immutable during
   implementation.
7. Local deterministic verification provides feedback; deterministic CI
   verification provides merge authority and never requires an LLM.
8. AI review is separate and configurable as `off`, `advisory`, or `required`.
9. A normal feature is proposed, approved, implemented, verified, archived,
   and submitted in one branch and one PR.
10. Framework maintenance is separate from product-change governance.

## 3. Actors and surfaces

### CLI: deterministic engine

The CLI owns scaffolding, schema resolution, parsing, validation, hashing,
approval, status derivation, adapter execution, verification, amendment
validation, archive mutation, framework diagnostics, and machine-readable
reports.  It never invokes an AI process.

### Skills/commands: agent steering wheel

`init` installs tool-appropriate wrappers for at least:

```text
crucible-propose
crucible-implement
crucible-verify
crucible-amend
crucible-archive
crucible-submit
crucible-status
```

Exact invocation syntax may differ by Codex, Claude Code, or another supported
tool, but the intent and CLI calls are the same.  A skill calls `status`, asks
the CLI for scaffold/instructions, authors allowed files in the active session,
then calls the CLI validator.  It cannot manufacture an allowed transition.

There is deliberately no approval skill.  `crucible approve` and amendment
re-seal are human terminal commands.

### Artifact-derived state

There are no persisted conversational checkpoints and no
`start`/`next`/`resume`/`finish` protocol.  `crucible status <change> --json`
derives the phase and exact next actions from files, schemas, bindings, seals,
and verification evidence.  Interrupted work resumes by inspecting reality.

Any local cache is gitignored, disposable, and forbidden as an enforcement
input.  Git plus sealed artifacts provide the audit record.

## 4. Proposal and oracle lifecycle

The propose skill uses the packaged, pinned OpenSpec runtime and Crucible's
custom schema to create the change.  It authors every pre-approval artifact,
including project-defined schema extensions, plus real oracle test files.

The agent chooses test locations and binding targets by inspecting the
repository's existing conventions.  Core does not prescribe a file.  The
configured adapter validates the result:

- each normative requirement has at least one oracle;
- every oracle references an existing requirement;
- every binding uses a configured runner and valid target grammar;
- `resolve` reports the target as collected and grounds it to a contained test
  file;
- the exact grounded test file enters the approval hash scope;
- new behavior or bug reproduction is proven red on the approved baseline when
  the change type requires it.

`resolve` returns only `found` with an exact `targetFile`, or `missing`.
`candidateFile` and CLI-authorized test paths are not part of the protocol.
Missing, ambiguous, outside-root, unsupported, or uncollected targets are red;
the agent edits the proposal/test and validates again.

`tasks.md` remains post-approval.  It is the implementation work breakdown, not
human-reviewed intent.

## 5. Human approval and sealing

From a terminal outside the agent session, the human runs:

```text
crucible approve <change>
```

Approve revalidates the resolved schema, renders the complete review surface,
shows declarative oracles beside grounded test code, and requires explicit
confirmation.  Decline writes nothing.

The seal covers:

- every schema-declared pre-approval artifact;
- every file under the change that the schema marks as approved intent;
- every bound oracle test file;
- pinned adapter/harness inputs that directly affect oracle judgment.

The schema, not a fixed filename list, determines custom artifact membership.
Any hash mismatch voids approval.  The agent cannot create or refresh a seal.

## 6. Implement and deterministic verify

The implement skill calls a CLI preflight.  Implementation is refused unless
the approval is present, valid, and current.  The agent writes `tasks.md`,
implementation code, and freely mutable ordinary unit/integration tests in the
same active session.

`crucible verify` is code, not an agent.  Locally and in CI it runs the
applicable deterministic set:

- current approved oracle targets;
- all prior archived regression oracle targets;
- configured unit/integration suites;
- build, typecheck, lint, and other declared deterministic suites;
- schema, traceability, approval-hash, adapter-pin, and oracle-immutability
  checks;
- concrete size and protected-path policies ratified for the reset.

Oracle `skip`, missing targets, malformed tool output, missing prerequisites,
or uncertain parsing are red.  Same-session agent review may produce useful
observations but is never completion evidence.

The words `verify` and `ai-review` are never interchangeable:

- `verify` is deterministic, credential-free, and required for merge;
- `ai-review` requires an LLM and follows its independent mode.

## 7. Amendment

Ordinary implementation defects require only a code/test fix and another
verify.  `amend` is reserved for changing approved intent, design promises,
oracle scenarios, or bound oracle tests.

The amend skill lets the active agent revise the affected artifacts and tests,
then the CLI validates the complete dependent set.  A human must separately
run `crucible approve --amend <change>` to inspect the delta and append a new
seal generation.  Until then implementation is blocked.  No amendment
checkpoint or agent-authored approval exists.

Override, escalation automation, tier ceremony, and ratchet issue automation
are parked until the ordinary lifecycle is qualified.

## 8. Schema-complete archive

Archive occurs on the feature branch before its PR is opened.  The active
change therefore never lands on the target branch as an intermediate state.

`crucible archive <change>` must:

1. revalidate the current schema, bindings, seal, and final deterministic
   verification evidence;
2. sync spec deltas into canonical `openspec/specs/`;
3. move the complete change directory, byte-for-byte, to OpenSpec's dated
   archive location;
4. preserve `.openspec.yaml`, proposal, design, `oracles.md`, `tasks.md`,
   `approval.yaml`, amendment history, and every custom extension artifact;
5. retain unknown extra files in the directory without silently granting them
   trusted status;
6. leave bound oracle code in the real project test suite so it joins permanent
   regression execution;
7. fail without a partial move if any validation, sync, or filesystem step
   fails.

Because the feature PR introduces the already-archived change, there is no
ordinary archive-only PR, blocked-archive recovery lane, or post-merge archive
registration protocol.

## 9. Distribution and adapters

Retain project-local, immutable distribution:

- the consumer records an exact released version or full source commit;
- a project-local launcher resolves only that pin and never an ambient CLI;
- Crucible packages its compatible OpenSpec runtime;
- Node runtime imports resolve to built JavaScript, not workspace TypeScript;
- installed adapter manifests and executables are version/content-hash pinned;
- `doctor` detects drift and offers explicit repairs.

*P4R-08 implementation contract:* `.crucible/framework.lock.json` v2 pins
`@crucible/core` by an exact release and a full package SHA-256. `init` copies
that built, self-contained release to `.crucible/framework/` and writes the
only launcher at `.crucible/bin/crucible`; the launcher verifies the lock,
manifest, and complete package bytes before invoking Node on its built
JavaScript entrypoint. The release embeds the tested OpenSpec runtime, so no
consumer `package.json`, `npx`, ambient `crucible`, or ambient `openspec` can
affect propose/archive. Packaging rejects source-only workspace output and
produces deterministic bytes; `doctor` reports framework drift but never
silently replaces the judge. Rationale: the project-local package makes the
ordinary Java consumer lifecycle independent of ambient Node tooling while
keeping framework upgrades outside ordinary initialization.

Framework core never imports a test framework.  Adapters remain separate JSON
executables.  The P4 Maven/Gradle dependency-backed discovery fix may be ported
only through the java-junit task's focused conformance, failure, no-test-
execution, and reproducible-package coverage.

## 10. Trusted CI and target-branch law

Every PR is judged by accepted target-branch trust inputs, even when the PR does
not edit them.  For base commit `B` and candidate `H`:

```text
trusted from B:
  enforcement config
  framework/verifier pin
  adapter pins
  historical oracle/harness inputs
  AI-review policy and rubric when applicable

evaluated from H:
  product implementation
  ordinary tests
  proposed approved change and new oracle tests
  proposed trust-file edits as untrusted candidate data
```

A candidate edit to policy or the verifier cannot affect its own evaluation;
after independent merge it affects later PRs.

The preferred GitHub design is an organization/enterprise ruleset-required
workflow stored in a separately trusted workflow repository and run on the
ordinary restricted `pull_request` event.  It checks out exact base and
candidate commits separately, reads trust inputs from base, uses the exact base
pin, executes candidate code without secrets or write permission, and emits the
required `verify` check.  Merge queues additionally require `merge_group`.

This logical contract is ratified; implementation is gated on a focused threat
model and executable proof.  `pull_request_target` is not the default because
GitHub warns against executing untrusted PR code in its privileged context.
Phase 4R must also choose an honest offering for repositories without required-
workflow support: a GitHub App, or a clearly labeled advisory repository-local
workflow.  `doctor --ci` must report the actual protection grade.

## 11. Optional AI review

AI review is a separate check and has three strict modes:

- `off`: no model call or AI-review check;
- `advisory`: run only when credentials are configured; findings never block;
- `required`: missing credentials, transport failure, malformed verdict, or a
  blocking valid finding is red.

The default must not require an API key.  Deterministic `verify` is identical in
all three modes.  A required reviewer is independent of the implementing
session and its output is schema-validated; agent prose is not a verdict.

## 12. Parked policy

The reset MVP does not vary authoring, approval, checks, or merge routing by a
computed tier.  Concrete policies such as size caps or protected trust paths
may be enforced directly when required by an acceptance test.  Existing tier,
override, trajectory, mutation, routing, and ratchet designs are historical
inputs, not active Phase 4R contracts.  They may return only after the thin
lifecycle is qualified and a separate design proves their user value.

## 13. Framework maintenance

Updating Crucible changes the judge and is not a product feature.  A dedicated
maintenance command stages only the immutable framework pin and deterministic
managed bytes, shows the exact diff, requires explicit human confirmation, and
refuses to mix product, test, OpenSpec change, or enforcement-policy edits.

The old accepted verifier may report what it can, but Crucible does not invent
product oracles or claim that a new judge authorized itself.  The selected
trusted-workflow/App deployment supplies the external root of trust.  No legacy
bootstrap classifier or consumer-specific root transaction is part of Phase
4R.

## 14. Delivery law

- Every task reads the sections named in its `Reads:` field and restates them
  before implementation.
- Acceptance tests are committed red before production code.
- A unit suite or template-string assertion is not consumer evidence.
- Required consumer tests are named, discovered, and non-skipped; missing or
  skipped evidence is red.
- Each green step is a small commit.
- Phase 5 cannot start until P4R-14 records both executable consumer flows and
  the manual UX walkthrough as green.
