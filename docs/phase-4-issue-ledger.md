# Phase 4 Issue Ledger

Running record of framework and operational issues discovered while validating
Crucible with `yet-another-notes-app`. Add the resolution and verification when
an issue is fixed; do not silently remove the history.

| ID | Issue | Status | Resolution / next action |
| --- | --- | --- | --- |
| P4-001 | A consumer CI workflow could not check out the pinned private `crucible-v2` source repository. | Resolved operationally | `crucible-v2` was made public. Consumer workflows can now read the exact source pin without a project PAT. The temporary PAT and Actions secret should be removed/revoked. |
| P4-002 | The Notes project's framework pin referred to commit `e32afd9`, which existed locally but was not reachable from the public `origin/main`; CI failed with `upload-pack: not our ref`. | Resolved | Published the existing fast-forward `main` commit. Re-running PR #3 produced green `verify` and `route` checks. |
| P4-003 | A global `crucible` executable (`0.1.0`) shadowed the current built Crucible CLI and lacked `doctor`. | Open operational issue | Use `node /home/vivardhan/Desktop/projects/crucible-v2/core/dist/cli/bin.js <command>` during validation, or later provide an intentional installation/distribution path. |
| P4-004 | A Java-only project’s first `propose` failed because Crucible invoked `npx openspec`, which depended on a consumer `package.json` and local OpenSpec installation. | Resolved | PR #25 packaged the exact `@fission-ai/openspec@1.6.0` runtime in `@crucible/core`; `propose`/`archive` invoke it with Node, and a regression test scaffolds from a repository with no npm project. The current safe rollout is a separately reviewed `init --framework-source owner/repository@sha` pin bump. P4-07 tracks the narrower dedicated update command. |
| P4-005 | No command auto-populates Phase 4 `docs/metrics.md`. | Deferred / non-blocking | Record rows through a post-merge agent instruction for now. Add a read-only, non-enforcement `crucible metrics` command only when manual collection becomes a real friction point. |
| P4-006 | A PAT injected into the existing `pull_request` workflow would be accessible to same-repository PR code and could be exfiltrated by a modified workflow. | Resolved by decision | Do not add PAT support to the shipped workflow. Public pinned source is the adopted bootstrap path; a private-source model requires a separate trust-boundary design. |
| P4-007 | Nested Codex propose sessions cannot use `workspace-write` on the Notes validation host: bubblewrap fails to create its loopback interface (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`), so the role cannot read or write and produces an empty bundle. | Resolved by P4-09 | `workspace-write` remains the default; an explicit gitignored `.crucible/local.yaml` `agent.codex_sandbox: danger-full-access` opt-in is available for the affected host. There is no automatic fallback, CI/enforcement remains unchanged, and focused config/substrate tests plus strict typechecking verify the contract. P4-08 skills are not a standalone fix because a thin wrapper would still spawn the same nested session. |
| P4-008 | On the Notes validation host, even a direct Codex `workspace-write` session cannot start filesystem commands because Bubblewrap cannot create its loopback interface. The P4-09 full-access opt-in is intentionally unacceptable to an operator who does not want to remove that boundary. | Design queued: P4-10 | Design a session-native local authoring lifecycle that removes the nested author-agent process without weakening CLI/CI enforcement. P4-10 must explicitly amend the fresh-context contract before implementation; it is not a silent P4-08 skill-wrapper expansion. |

## Resolution protocol

For a framework issue, fix it in `crucible-v2` under the normal test-first
workflow, update the relevant design/runbook documentation if a contract changes,
and record the fix commit/PR plus verification result in this ledger. Consumer
projects receive the fix through a separately reviewed framework-pin bump.
