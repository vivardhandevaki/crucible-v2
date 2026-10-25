# P4R-10 Target-Owned Deterministic CI

**Status:** P4R-10A ratified and executable boundary tests green. Transport
implementation remains gated on preserving this contract.

This design refines the logical target-branch law in
[`phase-4r-reset.md`](phase-4r-reset.md#10-trusted-ci-and-target-branch-law).
It does not reintroduce Phase 4 authority manifests, lane classifiers,
bootstrap/finalization paths, AI review, or framework-update behavior.

## Evidence checked on 2026-10-25

Current GitHub evidence does not contradict the preferred design:

- organization and enterprise rulesets can require a workflow stored in a
  selected source repository, branch, and workflow path;
- ruleset workflows support `pull_request` and `merge_group` (and also
  `pull_request_target`, which Crucible deliberately does not select);
- a merge queue needs an explicit `merge_group` trigger or its required check
  is never reported;
- ordinary fork `pull_request` runs receive no repository secrets and a
  read-only token;
- GitHub warns that `pull_request_target` becomes unsafe when untrusted PR code,
  scripts, dependencies, or artifacts are fetched and executed.

Primary references:

- [Troubleshooting ruleset workflows](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules)
- [Organization rulesets](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization)
- [Rules REST shape](https://docs.github.com/en/rest/orgs/rules)
- [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

## P4R-10A: exact trust partition

### Identities

For each run, the trusted workflow derives and records two immutable commit
identities before any candidate code or candidate-controlled executable input
runs:

- `B`: the event's exact base commit. A separately checked-out target-branch tip
  must still equal `B`; otherwise the event is stale and the run fails closed.
- `H`: the exact pull-request head commit, or the exact merge-group head commit.
  The candidate checkout must resolve to `H` byte-for-byte.

`pull_request` may name either a same-repository head or a fork head. Its
`GITHUB_SHA` is the synthetic merge commit and is recorded as event evidence,
not substituted for `H`. `merge_group` must use the target repository and its
`GITHUB_SHA` must equal the merge-group head `H`.

Every SHA is lowercase forty-hex. Every repository identity is an exact
`owner/name`. The base checkout, candidate checkout, and target-tip checkout are
distinct absolute paths. Missing or malformed identity evidence is a hard
failure.

### Origin of verification inputs

| Input | Required origin |
|---|---|
| enforcement config (`crucible.yaml`) | `B` |
| packaged framework/verifier and framework pin | `B` |
| adapter lock, manifest, and executable bytes | `B` |
| merged specs and previously archived oracle/harness definitions | `B` |
| AI-review mode/rubric if P4R-11 later enables it | `B` |
| implementation and ordinary tests | `H` |
| newly proposed, approved, pre-PR archived change bundle | `H` |
| newly bound oracle-test files | `H` |
| proposed edits to any base-owned path | untrusted data from `H`; ignored for this run |

The verifier executable itself comes from the package whose bytes and lock are
checked in `B`. It loads adapter bytes and historical oracle inputs from `B`,
while setting the adapter and ordinary-suite working directory to `H`. A new
archived bundle is evaluated as current candidate intent, not silently folded
into the historical set.

### Attacker capabilities

Assume an attacker can control every byte in `H`, including product code,
tests, OpenSpec artifacts, `crucible.yaml`, `.crucible/**`, workflow files,
action inputs, symlinks, package-manager scripts, and archive names. For a fork
PR the attacker also controls the head repository. They may race base movement,
reuse a stale event, forge a display-name-equivalent job, or supply malformed
event fields.

The attacker does not control the separately trusted ruleset workflow
repository, the active organization/enterprise ruleset, GitHub's event payload,
or `B` before it is accepted on the protected target branch. Candidate code
receives no secret, write token, persisted checkout credential, privileged
cache, or reusable runner state.

### Fail-closed boundary

The executable boundary rejects, before candidate execution:

- a base repository different from the event target repository;
- any malformed repository, ref, SHA, or checkout path;
- a base checkout that is not exactly `B`;
- a candidate checkout that is not exactly `H`;
- a target branch whose observed tip is no longer `B`;
- equal base and candidate roots or identities;
- a fork repository on `merge_group`;
- a merge-group event SHA different from `H`;
- an unsupported event or unknown field.

The returned machine partition enumerates the base-owned and candidate-owned
input classes above. Downstream transport accepts that validated value rather
than reconstructing trust from branch names or `HEAD`.

## P4R-10B: organization-ruleset required workflow

The enforcement-grade template is
`ci-templates/crucible-required.yml`. It is distributable framework data, but
it is **not** installed in the candidate repository. An organization or
enterprise administrator places it at `.github/workflows/crucible-required.yml`
in a separately trusted workflow repository, makes that repository accessible
to target repositories, and creates an active organization/enterprise branch
ruleset with `Require workflows to pass before merging` selecting the exact:

- trusted workflow repository ID;
- workflow path;
- immutable workflow commit SHA (and its ref);
- protected target repository/ref set.

The ruleset workflow rule is the expected source. A candidate-controlled job
with the same workflow or job display name is not the selected repository/path/
SHA and cannot satisfy it. The workflow repository should disable ordinary
Actions execution or retain the template's unconditional `if` behavior as
described by GitHub's ruleset-workflow troubleshooting guidance.

The template runs one stable check, `Crucible deterministic verify`, on both
restricted `pull_request` and `merge_group`. It:

1. parses and validates event identities before using them as action inputs;
2. checks out exact `B`, exact `H`, and the current target ref into distinct
   directories with `persist-credentials: false`;
3. makes the already checked-out B object available to H through a local Git
   fetch, never a candidate credential;
4. invokes B's hash-checking project-local launcher from the B checkout;
5. has that launcher re-check the checkout SHAs and target tip before loading
   base config/adapter/history and executing H code/tests.

The job has only `contents: read`, references no secret, uses no cache, and runs
on an ephemeral GitHub-hosted image. Official checkout/runtime actions are
pinned to immutable forty-hex commits. There is no `continue-on-error`, skipped
verification, or cancelling concurrency. GitHub's active required-workflow rule
therefore keeps a missing, cancelled, stale, or failed run red.

The base-owned CLI discovers candidate changes as canonical archive directories
present in H but absent from B. It revalidates each bundle against B's schema and
adapter, checks schema-complete approval scope, remaps the preserved pre-archive
seal paths without rewriting approval evidence, and then runs deterministic
verify. H edits to base historical archives or trust files are ignored for the
current result.

## P4R-10C: non-organization offering decision

### Tradeoff record

An expected-source GitHub App could post a ruleset-required check from a source
the candidate cannot spoof, including for repositories that lack organization
required workflows. It would also add a hosted service, App credentials,
webhook delivery/replay state, installation permissions, check-run publishing,
availability obligations, and a new identity/commit-binding proof. That expands
the P4R-10A trust model and is not the minimum thin-lifecycle offering.

A repository-local workflow needs no service, credential, or new operational
control plane. It can run the same deterministic B/H verification for useful
feedback, but the candidate can edit or delete the workflow that produces the
check. A repository status-check rule cannot turn those candidate-controlled
bytes into an expected source merely because the display name matches.

### Decision

Phase 4R ships the **explicitly advisory repository-local workflow**. A GitHub
App is not selected. This avoids a design amendment and keeps App implementation
outside P4R-10.

`crucible init` installs `.github/workflows/crucible.yml`; both the workflow
name and its only job say `advisory` and `not a merge authority`. The generic
and Java/JUnit paths intentionally use one template because it provisions the
pinned supported Node and Java runtimes before calling the base-owned verifier.
The workflow uses `pull_request` and `merge_group`, never
`pull_request_target`, and retains the no-secret/read-only/ephemeral controls of
the required template.

An absent, modified, or partially installed local workflow is unhealthy, but a
perfect installation remains grade `advisory`. A green local check never
upgrades it. P4R-10D makes that distinction machine-readable.
