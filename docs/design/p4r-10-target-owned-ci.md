# P4R-10 Target-Owned Deterministic CI

**Status:** P4R-10A ratified; executable boundary tests intentionally red until
the P4R-10A implementation commit. Transport implementation is gated on those
tests becoming green without weakening this contract.

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

## Pending subtask decisions

P4R-10B will record the exact trusted-workflow installation and runtime proof.
P4R-10C will record the non-organization tradeoff and decision only after that
proof exists. P4R-10D and P4R-10E will then add diagnostics and privileged-event
guardrails against the selected transports.
