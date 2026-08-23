# Phase 4 Lessons — Why Crucible Reset

Phase 4 was intended to validate Crucible by building a real Spring Boot
consumer.  It instead became a reactive framework redesign.  Each consumer
failure produced another lifecycle, CI, review, upgrade, or recovery mechanism
before one ordinary consumer path had been qualified end to end.

The final experimental state is preserved at Git tag
`p4-experimental-final-2026-08-24` and branch
`codex/p4-experimental-archive`.  It is evidence, not the implementation base.

## What the validation proved

1. Crucible's original premise remains sound: humans approve intent artifacts
   and oracle tests; deterministic machinery judges implementation against
   those sealed goalposts.
2. The intended developer experience must remain close to OpenSpec: generated
   agent skills steer a CLI, while artifacts and CLI preconditions carry state.
3. A CLI that launches another agent creates avoidable sandbox, context,
   recovery, and trust-boundary problems.
4. Framework distribution must be project-local and immutable.  Ambient CLIs,
   mutable branches, and consumer-installed OpenSpec runtimes are not reliable.
5. Adapter boundaries work.  The Java/JUnit adapter exposed real dependency
   classpath defects that belong inside the adapter, not in core.
6. Deterministic verification and LLM review are different products.  Verify
   needs no API key and is the required merge check.  AI review is separately
   `off`, `advisory`, or `required`.
7. A PR must not select the configuration, verifier, adapter, or workflow that
   judges itself.  The logical target-branch rule is retained; its GitHub
   transport needs one focused, proven design.
8. Archiving after a feature has already merged creates a second lifecycle and
   unnecessary recovery lanes.  A normal branch must archive before opening
   its single product PR.

## What is retained

- OpenSpec artifact format and custom-schema integration.
- Proposal-time human-readable oracles plus real bound test code.
- Traceability from normative requirement to oracle to collected test target.
- Terminal-only human approval and SHA-256 sealing.
- Post-approval oracle and intent immutability.
- Deterministic local and CI verification.
- Strict adapter JSON protocol and packaged adapter pins.
- Project-local framework distribution, immutable source/version pins,
  packaged OpenSpec, built-JavaScript runtime exports, and `doctor`.
- Dependency-backed Java/JUnit discovery, if it independently passes the
  adapter conformance and Spring acceptance suites when ported.
- Target-branch enforcement as a logical contract.

## What is removed from the reset MVP

- CLI-spawned Codex or Claude authoring/review sessions.
- Headless versus session-native workflow modes.
- Persistent `.crucible/sessions/**` checkpoints and their migrations.
- `start`/`next`/`resume`/`finish` handoff state machines.
- Adapter `candidateFile` suggestions and path-authorization handoffs.
- Session-native review and amendment work orders.
- P4 authority manifests, PR-lane classifiers, legacy bridges, finalization
  lanes, solo-posture root bootstraps, and blocked-archive recovery.
- Committed `state.yaml` as workflow state.  Status is derived from artifacts;
  any cache is gitignored and non-authoritative.
- Tier-dependent ceremony, routing, mutation, overrides, trajectory checking,
  and automated ratchets until the thin lifecycle is qualified.

## Root causes

### Validation stopped being the gate

Framework CI and structural template assertions were repeatedly treated as
completion even when the required disposable consumer flows had not run.  The
next real consumer then found the missing behavior.

### Transport concerns reshaped the product

Nested-agent sandbox failures led to a new persisted session protocol.  CI
credential constraints led to detached reviewer workflows.  Framework upgrade
constraints led to multiple authority lanes.  These were infrastructure
symptoms; they should not have changed the ordinary user workflow.

### Exceptional paths arrived before the ordinary path

The framework gained upgrade, bootstrap, advisory posture, archive-only, and
recovery transitions before it could reliably execute one branch from init to
archived, verified PR.

### Documentation acceptance outran executable evidence

Several tasks declared real-Git and worked-consumer acceptance but landed only
string or structural tests.  Phase 4R therefore requires named, non-skipped
consumer tests before production implementation and treats missing evidence as
red.

## Reset rule

No Phase 4 mechanism is ported because it exists or once passed a unit test.
Each retained idea is reintroduced only through a Phase 4R task with failing
acceptance coverage, a narrow contract, and proof in the generic or Spring
consumer lifecycle.
