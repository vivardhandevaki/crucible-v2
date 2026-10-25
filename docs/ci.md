# Crucible CI protection

Crucible has two GitHub offerings. They run the same credential-free
deterministic verifier but have different trust grades.

## Organization/enterprise enforcement

For enforcement-grade protection, put the shipped
`ci-templates/crucible-required.yml` at
`.github/workflows/crucible-required.yml` in a separately trusted workflow
repository. In an active organization or enterprise branch ruleset, select
**Require workflows to pass before merging** and bind the exact source
repository, path, ref, and commit SHA. Target protected branches that merge only
through pull requests. Make the workflow repository accessible to the target
repositories.

Do not configure a same-named required status check from “any source.” The
workflow rule's source repository/path/SHA is what prevents a candidate job
with the same display name from satisfying the rule. The template covers both
`pull_request` and `merge_group`; a missing, cancelled, stale, or failed run
therefore remains blocking.

GitHub setup references:

- [Create organization rulesets](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization)
- [Troubleshoot required workflows](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules)
- [Rules API workflow fields](https://docs.github.com/en/rest/orgs/rules)

## Repository-local advisory feedback

`crucible init` installs `.github/workflows/crucible.yml`. This is the supported
offering when organization required workflows are unavailable. It is always
**advisory** because a candidate can edit repository-local workflow bytes. A
green check is useful feedback, not merge authority.

The workflow and job names say this explicitly. If it is missing or modified,
ordinary `crucible doctor` offers the shipped bytes as a reviewed fix.

## Diagnose the installed grade

Inspect locally provable protection:

```sh
.crucible/bin/crucible doctor --ci
.crucible/bin/crucible --json doctor --ci
```

This reports an exact local installation as `advisory`, never enforcement.

To diagnose remote ruleset evidence, collect a snapshot from GitHub's active
rules/ruleset APIs and pass it explicitly:

```sh
.crucible/bin/crucible --json doctor --ci \
  --ci-observation /path/to/github-ci-observation.json
```

The strict version-1 JSON shape is:

```json
{
  "version": 1,
  "access": "ok",
  "repository": "acme/widget",
  "target_branch": "main",
  "target_sha": "<40-hex target SHA>",
  "observed_sha": "<same freshly observed SHA>",
  "installation": {
    "kind": "required_workflow",
    "ruleset_source": "organization",
    "enforcement": "active",
    "bypass_actors": 0,
    "target_repository_id": 100,
    "source_repository_id": 200,
    "workflow_path": ".github/workflows/crucible-required.yml",
    "workflow_ref": "refs/heads/main",
    "workflow_sha": "<40-hex trusted workflow commit>",
    "workflow_content_sha256": "<sha256 of the fetched workflow bytes>",
    "events": ["merge_group", "pull_request"],
    "check_name": "Crucible deterministic verify"
  }
}
```

Unknown fields, stale SHAs, inaccessible evidence, partial rules, repository-
controlled sources, bypasses, changed workflow bytes, wrong events, and wrong
check names all fail closed. The command is diagnostic only; it never repairs
remote rules without explicit administrator action.

## No `pull_request_target` candidate execution

Supported templates do not use `pull_request_target`. Crucible's workflow
inspector rejects candidate head/fork checkout, indirect `git`/`gh` fetching,
candidate-selected remote scripts, downloaded artifact reuse, and shell/local-
action execution after candidate material enters a privileged job.

There is no approved exception. A future exception requires a separately
ratified bounded threat model and executable guard tests before any supported
template or installation path may use it.
