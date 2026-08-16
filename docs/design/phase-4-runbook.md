# Phase 4 — Validation Project Runbook

Phase 4 has **no framework design doc by decision** (PHASES.md): the product's designs are Crucible artifacts in the product's own repo. This runbook covers only the framework-side operation: kickoff, instrumentation, and how remaining backlog items get pulled in.

## Kickoff checklist (product repo)

1. `crucible init` — pin java-junit, accept defaults, then **edit risk globs deliberately** for the product's real risk surface (payments/auth/migrations/etc. — don't ship defaults unexamined).
2. Install both maintained CI workflows (mechanical JDK/Testcontainers verify plus detached reviewer); configure the repository reviewer secret; confirm branch protection requires verify + review + route; auto-merge enabled.
3. Commit the initial spec baseline (even if near-empty): the archive grows from here.
4. Configure settings.yaml models per charter routing (strongest for propose); local.yaml notify hooks.
5. First three changes deliberately span the tiers: one trivial (repo chore), one standard feature, one critical-path feature — shakes out routing, the approve surface, and escalation early, when stakes are low.

## Validation bootstrap (before public distribution)

Phase 4 deliberately validates Crucible before a public npm/binary release exists. Run `crucible init` from a committed Crucible GitHub checkout (or pass `--framework-source owner/repository@<40-character-lowercase-sha>`). It writes `.crucible/framework.lock.json`, a strict source pin. The shipped CI workflow reads both that pin and `crucible.yaml` from the target branch, checks out the exact commit into a separate directory, builds it with `npm ci && npm run build`, and executes that built CLI. A PR therefore cannot select the harness that judges itself.


The built CLI executes under plain Node. Every workspace package statically reachable from it must export built JavaScript at runtime rather than TypeScript source; its TypeScript declaration condition may remain source-visible so the workspace can typecheck before building. Node never takes that type condition. Missing runtime build output is a fail-closed framework error, never a reason to introduce a TypeScript loader in the consumer workflow.

## Detached CI reviewer setup (P4-14)

CI separates code execution from reviewer credentials. The ordinary `pull_request` workflow builds and tests the PR with no review secret. The target-branch-owned `pull_request_target` reviewer workflow may fetch PR git objects only as inert input; it never checks out or executes the PR head. Target-branch pinned core prepares a bounded request, the pinned official Codex Action runs in a clean temporary directory with `drop-sudo` and `:read-only`, and a different job with no secret strictly judges the returned batch verdict.

Repository setup is fail-closed:

- create the Actions repository secret `OPENAI_API_KEY`; never expose it as a workflow/job environment variable or to Maven, Gradle, project scripts, dependency installation, or PR-owned code;
- preserve the action default that only actors with repository write access may trigger it; never configure `allow-users: "*"`; external-contributor support requires a separately ratified maintainer-approval flow;
- require the exact check names `verify`, `review`, and `route` in branch protection. The detached workflows cannot directly depend on one another, so branch protection's conjunction is the enforcement join;
- pin the Codex Action by immutable commit and the Codex CLI by exact version. Keep the reviewer model, permission profile, prompt, output schema, and failure posture in the target-branch managed workflow;
- treat a missing secret, denied actor, action/tool failure, malformed or stale verdict, or absent review check as blocking. Do not remove `review`, reuse a local verdict, or add a TypeScript/agent fallback.

Roll out in two product PRs: first merge an isolated framework-pin + generated-workflow update under the old target-branch harness; then configure the secret and required checks and validate the detached review. Only after those are green should an existing governed feature PR be rerun. Official setup and security constraints are documented by the [Codex GitHub Action guide](https://learn.chatgpt.com/docs/github-action) and [Codex Action security guide](https://github.com/openai/codex-action/blob/main/docs/security.md).

The framework packages and invokes its exact pinned OpenSpec runtime itself. A consumer repository, including a Java/Spring Boot project, does not need a `package.json`, `npm init`, or a separate OpenSpec installation to use `propose` or `archive`.
The pin is part of the approval hash scope whenever present; changing it after approval voids approval. A framework bug is fixed in the framework repository first, then the product receives a separately reviewed pin-bump change. This is a validation-only bootstrap, not a distribution mechanism: publishing and release lifecycle remain deferred under Backlog B12.

## Session-native local workflow (P4-08 + P4-10)

`crucible init` installs a `$crucible`/`/crucible` hub and command-specific Codex/Claude skills. The hub never guesses from conversation history: it asks the pinned local launcher for artifact-derived status and shows only the returned actions. Propose/revise, implement, and (after P4-21) amend run in the already-active interactive session through `crucible session` handoffs. Review retains its separately opened fresh-session ceremony. The propose skill uses Crucible's packaged OpenSpec primitives through the CLI, never `/opsx:propose` or a global `openspec`.

The operator chooses the interactive agent surface and its permissions before starting Crucible. Those permissions are local and advisory; Crucible never broadens them, and P4-09's `danger-full-access` remains a separate explicit opt-in rather than a fallback. CI still uses the target branch's config and source pin, so neither a skill, launcher, session checkpoint, transcript, nor `state.yaml` can change what merges.

Recovery is always CLI-led:

- interrupted/partially scaffolded proposal: invoke the propose skill again; `session resume` replays the persisted explicit intent, migrates a legacy P4-10 authoring checkpoint if necessary, and derives the next artifact or oracle-test instruction;
- after `oracles.md`: keep invoking the propose skill while the CLI returns exact adapter-grounded bound-test paths; `tasks.md` is never authored before approval, even if raw OpenSpec status considers it ready;
- dependency-backed JVM oracle tests: `resolve` compiles and asks Maven/Gradle for the evaluated test execution classpath, but does not run tests. Dependency/model/tool/linkage failure is a framework-side adapter failure, not a missing target and not a new oracle-test handoff; stop and use the framework-bug escalation below rather than editing the product test to evade class loading;
- red or malformed proposal: fix only the paths named by the handoff/report, then retry `session propose finish`; unresolved bindings remain red, and a target the adapter cannot map safely must be corrected through the exact `propose revise` command reported by the CLI;
- pre-approval intent change: use session-native `propose revise`; an approval already present requires the managed amend skill and its pinned `session amend` handoffs;
- interrupted implementation: invoke the implement skill again; the approval-bound checkpoint returns either the tasks or implementation stage;
- missing/malformed/stale checkpoint or missing pinned launcher: stop on the CLI's exit 2/3 teaching error and run the named restart or `init` command—never infer a stage or fall back to an ambient executable.

## Instrumentation (success criteria — record from day one)

Source of numbers: state.yaml events + approval.yaml timestamps + PR/check metadata. Until a `crucible metrics` command exists (build it just-in-time if manual collection annoys — it's a legitimate Phase 4 framework task), keep `docs/metrics.md` in the product repo, one row per merged change:

| change | tier | type | gate minutes | escalations (n, resolution mins) | amends | verify local latency | CI latency | routing | override? | escaped defects (later) |

Plus running counters: auto-merge rate, override count (target ≈ 0), ratchet commits (each escaped defect must produce one — bugfix type enforces it).

**At project end:** write `docs/validation-report.md` — the numbers vs. the charter's instruments, plus qualitative DX notes (where the gate felt heavy, where tasks were wrongly sized, which rubric lines fired, which never did). This is the evidence for "Crucible delivers," and the input for deciding distribution (backlog B12).

## Just-in-time backlog pulls (Category A → framework tasks during Phase 4)

Pull an item **only when the product first needs it**, as a normal framework task with design-then-implement discipline:

- A5 mutation/PIT — when the first critical-tier change merges (blocking mutation is defined for critical tier; until PIT lands, capability negotiation must loudly report "mutation unavailable" and force human review on critical — verify this degradation actually fires).
- A6 stacked changes — first legitimately >400-line change.
- A7 audit digest — once auto-merges accumulate (start manual: weekly review of the 10% sample from state records).
- A9 override automation polish — first real override.
- Remaining A items (capability taxonomy finalization, approve-surface refinements) — as friction reveals priority.

## Escalation of framework bugs

A framework bug found mid-product is fixed in the framework repo under its normal discipline (test-first, amendment of design docs), pinned version bumped in the product. Never patch around the framework inside the product — that's exactly the drift Crucible exists to prevent.

For P4-12 specifically, leave the product proposal and session checkpoint in place while the framework's Java/JUnit classpath defect is fixed. After the framework fix is merged and the product receives a separately reviewed pin bump, rerun `session propose next`; ordinary resolver discovery must return every bound target as `found` before the checkpoint may become `ready`. Do not approve, implement, or replace a dependency-backed integration test with a weaker test while resolution is unavailable.

For P4-13 specifically, leave the product implementation and PR in place while the built-CLI package-export defect is fixed. Do not edit a consumer workflow to add a TypeScript loader or bypass target-branch enforcement. After the framework fix is merged and the product receives a separately reviewed pin bump, re-run the existing PR's CI; the same pinned built CLI must reach ordinary verification under Node 20.

For P4-14 specifically, leave the Notes `create-note` implementation and PR unchanged while the framework reviewer transport is implemented. The current `SUBSTRATE_UNAVAILABLE` result is a red enforcement outcome, not evidence against the product. After the framework implementation merges, use the isolated pin/workflow rollout above, configure `OPENAI_API_KEY` and all three required checks, then rerun the preserved PR. Never put the key in the ordinary workflow, install a global authenticated CLI there, remove review without installing the detached required check, or approve/merge around the red reviewer.

## Definition of done (Phase 4 = charter headline)

Production-grade, consumer-ready product shipped end-to-end through Crucible; validation-report.md written; zero un-ratcheted escaped defects; backlog re-groomed with Phase-4 learnings (esp. distribution readiness).

## Advisory CI-review rollout (P4-15)

A validation project may deliberately defer API spend by merging target-branch `review.ci_mode: advisory`. Until that config is present, P4-14 required mode remains law and a missing key is red. In advisory mode require only `verify` and `route`; the workflow reports that CI review did not run, makes no model call, and emits no reviewer verdict. Local review is recommended feedback but never merge evidence. Oracle and regression suites remain mandatory.

To enable later: add `OPENAI_API_KEY`, merge a dedicated risk-routed config PR changing the mode to `required`, validate the detached reviewer, then require its judge check. Never infer advisory mode from secret absence or describe it as full adversarial-review enforcement.


## Framework source-pin upgrades (P4-16)

Do not start `session propose` for a pin/workflow-only rollout. It is a framework bootstrap event with no honest product oracle, and P4-14 already gives it a no-governed-change path under the old harness.

1. Start from a clean product target branch and keep unrelated local files untouched.
2. Build the already-merged candidate framework checkout and invoke its `init` directly from the product root. Confirm only understood Crucible-managed file replacements.
3. Inspect the diff. The isolated PR may contain the framework lock and candidate-`init` managed harness bytes only. It must contain no product source/tests, `openspec/changes/**`, `crucible.yaml`, settings/local config, or unrelated edits.
4. Open a human-reviewed pin PR. Target-branch CI remains the old harness; the proposed workflow cannot judge itself. Require the old deterministic checks and never synthesize a passing review result.
5. After merge, rerun `init` from the target pin to refresh the ignored local launcher. Only then start ordinary governed work or a separate target-config change.

If `session propose start` was invoked accidentally, remove that unapproved empty scaffold and its ignored checkpoint before committing the pin branch; they are not evidence and must not enter the PR. For a required-to-advisory reviewer transition, follow architecture §13 order: remove only the judge branch-protection requirement first, merge the pin, then submit the separate risk-routed mode change. `verify` and `route` stay required.

## Planned enforcement-config edits (P4-17)

When a governed bundle specifies a future edit to `crucible.yaml`, approval's pre-implementation diff may not yet contain that risk path. Approve it with `crucible approve --tier critical <change>` so the human completes the critical per-oracle walk and the approval carries a durable critical floor. Do not edit config before approval to manufacture the tier, and do not use the P4-16 pin-only lane for policy.

After implementation, local and CI verify recompute the final diff using their normal config authority and take the maximum of that result and the approved floor. If final facts become critical without a complete critical acknowledgment record, stop: the existing approval did not authorize critical ceremony. Do not push around the failure, hand-edit `approval.yaml`, or weaken a risk glob. Return to the approval gate with unchanged sealed goalposts and obtain the required critical approval before continuing.

## Review posture and local reviewer rollout (P4-18/P4-19)

At interactive `init`, choose PR AI review and independent human review separately. Do not provide an API key to Crucible and do not let secret detection choose a mode. The exact target-branch check sets are: full (`verify` + detached judge + `route`), human-only (`verify` + `route`), AI-only (`verify` + detached judge), or solo (`verify`). In every posture `verify` still runs the current oracles, full CI regression, traceability, seals, diff caps, and tiering. Configure GitHub's required checks to exactly the set init prints; Crucible does not change repository settings for you.

The recommended solo posture is `ci_mode: advisory`, `human_mode: advisory`, and local `review.local_mode: required`. Local implementation then stops after green mechanical verification and asks for the intended diff to be committed. Run the returned local-review command: it launches a fresh reviewer over that exact commit snapshot. Green exposes final verify. Red requires the human to inspect the rubric findings and explicitly return to implementation; update tasks/unsealed code, recommit, and repeat. Never let the implementing session review itself, reuse a verdict after HEAD changes, or represent local green as CI evidence.

After P4-20, the session-native implementation path does not launch a nested reviewer process. At `review-pending`, stop the implementation conversation, open a fresh Codex conversation in the same repository, and invoke the managed `review` skill with the change name. The skill obtains its exact work order and verdict path from the pinned CLI, writes the strict verdict, and asks pinned core to judge it. Do not invoke the skill in the implementing conversation, manually choose a verdict path, paste a verdict into chat, enable `danger-full-access`, or treat a missing verdict as a pass. Headless `crucible review` remains available as an explicit child-process mode but is not the session-native required-review transport.

For reviewer-red recovery, inspect the structured findings. Block findings use `session implement review-address`, followed by changes only to tasks and unsealed implementation bytes, a new commit, mechanical verify, and a fresh review. A missing/transport verdict with an unchanged snapshot uses the explicit `session implement review-retry`; it never returns to code and never reuses the old path. Any changed HEAD, approval, rubric, or tracked diff invalidates retry.

The Notes P4-20 evidence is the committed `enable-solo-review-posture` snapshot `743ec64` plus a `review-red` checkpoint and transcript showing repeated verdict writes denied by nested Bubblewrap. Preserve that branch and do not merge, fabricate a verdict, select Claude, or enable full access. Because its approval seals the P4-18/P4-19 framework lock, do not update that branch's pin in place. Merge P4-20 in the framework, pin it on Notes `main` through the isolated bootstrap lane, then restart and critically reapprove the policy change from the new target pin before invoking the fresh review skill. PR #8 remains untouched throughout.

For the current Notes bootstrap, do not merge PR #13: its sealed proposal explicitly retains `route`, so it cannot honestly authorize solo posture. Merge P4-18/P4-19 in the framework first. Then remove the future-disabled `route`/judge requirements from the Notes ruleset, merge one isolated framework pin plus candidate-init managed-workflow PR under the remaining old checks, and start a new governed critical-floor Notes policy change for both advisory fields. Preserve `create-note` throughout. The new target branch must show only `verify` as required before the product feature PR is resumed.

## Session-native amendment recovery (P4-21)

Invoke the managed amend skill with the change name and the explicit human resolution. Pinned core must validate the current seal before returning any write instruction. The active session may edit only the artifact and bound-test paths named by the handoff, repeatedly invoking `session amend next` until every binding is grounded. A post-approval `tasks.md` may remain in place; it is ignored by amendment judgment and must not be moved, rewritten, sealed, or treated as proposal material.

When `session amend finish` returns ready, stop agent authoring and ask the human to run the exact `session amend seal` command. That command reruns validation and displays the amendment diff before confirmation. A decline or red judge leaves the old approval unchanged and any escalation unresolved. A successful seal invalidates prior implementation/review checkpoints and restarts implementation from tasks against the new approval. Never hand-edit `approval.yaml`, reuse an old local-review verdict, invoke a nested agent, or enable `danger-full-access` as recovery.

For the current Notes P4-21 evidence, preserve `enable-solo-review-posture-p4-20` at commit `40a404a`. The first amend attempt failed on the legitimate downstream `tasks.md`; the second, after a recoverable temporary move, produced no artifacts because nested Bubblewrap denied the child role, and the checklist was restored. Keep the policy implementation and bound oracle unchanged. After P4-21 merges, use the isolated framework-pin lane, rerun init from the target pin, resume through the managed amend skill, obtain the human amendment seal, then rerun implementation, fresh local review, and final verify. PR #8 remains untouched.

## Derived-state diff recovery (P4-22)

If a change remains over its diff cap because mandatory Crucible commands append `openspec/changes/<change>/state.yaml`, stop amendment churn. Do not delete audit events, hand-edit the cache, raise the target cap, omit required review, or compress approved intent merely to offset derived bytes. Record the raw and effective line facts separately; before P4-22 the effective value cannot be enforced honestly by the pinned judge.

Preserve the Notes retry `enable-solo-review-posture-p4-21` at committed snapshot `ec2172d`; its compacted sealed bundle and passing fresh verdict are evidence, but its P4-21 judge still reports 415/400 because the 52-line derived state file is counted. After P4-22 merges and is pinned through the isolated target-branch upgrade lane, restart and critically reapprove the policy change from that target pin. Reuse the policy semantics and oracle, not the old seal or verdict. The new pin must prove that exact state rows are absent from effective touched paths/line counts while all policy, workflow, artifact, and test bytes remain counted. Keep PR #8 untouched.

## Target enforcement snapshot recovery (P4-23)

If CI reports `REVIEW_POSTURE_DRIFT` for both managed workflows while local verification is green, compare the target commit's workflow blobs with the templates from its framework pin before editing the policy PR. If those blobs match, inspect the `--config-from` directory construction: P4-22 and earlier CI templates copied only `crucible.yaml` and the framework lock, so the congruence judge correctly saw an incomplete target snapshot. Do not copy PR workflows into the snapshot, remove the congruence check, downgrade the error, or merge around required `verify`.

Merge P4-23 in the framework, then use the P4-16 isolated bootstrap lane to pin it and regenerate the target's managed workflow. That bootstrap PR contains only the framework lock and deterministic managed harness bytes; it has no `crucible.yaml`, settings, product/test, or OpenSpec change. The old target harness judges it. After merge, rerun init locally from the target pin and restart the governed policy change because its old approval seals the P4-22 framework lock.

For Notes, preserve PR #18 (`enable-solo-review-posture-p4-22`) as evidence: its local oracle, fresh review, and P4-22 diff-cap verification passed, while CI failed before ordinary verification because its target snapshot omitted both workflow paths. Do not amend its sealed framework lock. After the isolated P4-23 pin/workflow rollout reaches `main`, close or supersede PR #18, start a fresh critical-floor posture change from the new target, and keep PR #8 untouched.

## Target-owned CI recovery (P4-24)

If a generated pin PR fails before framework checkout because one workflow step cannot consume another step's snapshot, stop the rollout. Do not patch the consumer path only, merge the pin around `verify`, rerun a sealed product change against a different lock, or open another product policy retry. Compare the task's named acceptance list with the tests that actually shipped; missing real-Git, worked-consumer, or bootstrap coverage is a framework release failure even when the root suite is green.

P4-24 replaces the shared-path convention with one bootstrap output contract and makes the mechanical workflow base-owned. Before implementation, tests must fail by executing the exact P4-23 generated steps and reproduce Notes PR #19's missing nested lock. After implementation, run the same scripts for generic/Java templates, every review posture, hostile candidate workflow/config replacements, no-change bootstrap, governed changes, and every malformed/tool-failure case. A local Notes-shaped simulation must use the built candidate framework, generated files, an exact base/head repository, and the same control-file outputs as GitHub Actions; `doctor` alone is insufficient.

For Notes, keep PR #8 (`create-note`), PR #18 (`enable-solo-review-posture-p4-22`), and PR #19 (`pin-crucible-p4-23`) unmerged as evidence. Once P4-24 merges, close #19 as superseded and create one clean P4-16 pin/workflow PR from current `main`; the generated P4-24 workflow must pass its executable snapshot consumer. After that pin reaches `main`, close #18 and create a fresh critically approved solo-posture change. Only after the target policy is merged should `create-note` be restarted from the new pin; do not reuse its old approval, verdict, or CI result.

## P4-25 release recovery

P4-24 is not safe to roll into another consumer merely because its framework CI was green. Before any new Notes PR, require the P4-25 acceptance manifest and built-candidate Notes mirror. The mirror starts at current Notes `origin/main` and must reproduce the actual P4-22 pin, legacy `pull_request` trigger, absent explicit review policy, Java adapter, and open historical branches without reading or editing those branches.

Do not run full `crucible init` for a framework upgrade. It owns enforcement config, convenience settings, schemas, adapters, instructions, and skills, so even an operator who stages only some outputs cannot use its report as proof of the P4-16 allowlist. Run only `crucible framework upgrade --source <repository@sha>` from a clean dedicated worktree. If the command reports a legacy authority transition, follow its exact two PR phases; do not collapse them, remove a required check, copy a candidate workflow onto the target snapshot, or claim a `pull_request_target` workflow ran before it existed on the default branch.

For each phase, inspect the command machine-readable classification and `git diff --name-status`. Phase one is `legacy-bootstrap` and may contain only the new lock and exact transition workflow bytes. It requires `--acknowledge-legacy-bootstrap`; temporarily remove `verify` from GitHub required checks, manually compare that two-file diff, and do not treat its candidate-owned job as an authority result. After the bridge merges, restore `verify` as required. Phase two comes from a fresh clean target checkout at the same pin, may contain only exact final managed-workflow bytes, and is judged by the target-owned transition workflow. Any config, settings, skill, schema, adapter, product, test, OpenSpec bundle, untracked-to-tracked, unrelated path, bridge drift, or bridge repin stops the rollout.

After final authority lands, create a fresh critically approved solo-posture change. Its PR may show the old target's detached AI/human recommendations until the policy merges, but deterministic `verify` must be green and any override is forbidden. Once the target explicitly selects advisory CI/human and required local review, restart create-note as a fresh change: author and approve new artifacts/tests against the P4-25 lock, complete implementation and fresh local review, then require the target-owned CI authority/verify result. Close #18 and #8 only when their replacements exist or the user explicitly chooses to abandon them; never reuse their seals or verdicts.
