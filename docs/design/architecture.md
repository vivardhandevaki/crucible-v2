# architecture.md — Cross-Phase Stable Contracts

**Status: seed.** This file holds only contracts shared across phases. Phase design docs reference it and never duplicate it. It starts small and grows as Phase 1 settles interfaces. The amendment discipline applies here most strictly: changing this file is changing the law of the codebase — same commit as the code, rationale required. Sections marked `[SETTLES: P1]` are filled/frozen by the named phase.

## 1. Module map & layering (core/)

```
cli/          command entry points; parses args, prints, exits. No logic.
commands/     one module per command; orchestrates lower layers.
artifacts/    read/parse/validate OpenSpec + Crucible artifacts (bundle, oracles, spec deltas, approval, state, escalation)
hash/         canonical sha256 file/bundle hashing; approval sealing & verification
lint/         traceability: extraction + set arithmetic
tier/         tier computation from facts (spec delta, globs, diff size)
verifyx/      verify orchestration; aggregates check results into a report
substrate/    AgentSubstrate interface + Codex/Claude Code/Fake implementations + runtime resolver
adapters/     adapter client: manifest loading, spawn, JSON transport, result normalization
config/       crucible.yaml / settings.yaml / local.yaml loading + validation
state/        state.yaml event log (write-only from commands; reconcile in status)
session/      strict local authoring handoffs/checkpoints; never imported by enforcement
notify/       convenience-only dispatch (terminal/desktop/webhook/github); may fail, never blocks (added P2-00, built P2-15)
util/         pure helpers only
```

**Dependency direction (enforced by convention, later by lint):** `cli → commands → {artifacts, hash, lint, tier, verifyx, substrate, adapters, config, state, notify} → util`. Lower layers never import upward. `substrate` and `adapters` never import each other. Nothing outside `substrate` invokes an agent; nothing outside `adapters` spawns an adapter process.

## 2. Exit codes (CLI-wide)

| Code | Meaning |
|---|---|
| 0 | Success / all checks green |
| 1 | Checks ran and failed (verify red, lint failure, reviewer block) |
| 2 | Precondition unmet (message must name the exact next command) |
| 3 | Invalid config, schema, or artifact (fail-closed on malformed input) |
| 4 | Internal error (bug in Crucible; stack trace to stderr) |

Rule: exit 2 and 3 messages are teaching surfaces — they name the file, the problem, and the fix.

## 3. Error taxonomy

All thrown errors extend `CrucibleError { code: ErrorCode, exit: 2|3|4, hint: string }`. Never throw bare strings/Errors from below `commands/`. `hint` is the "run X" teaching line. Fail-closed mapping: any parse/validation uncertainty → exit 3, never a warning.

The taxonomy lives in `util/errors.ts` (the lowest layer), not in `cli/`, so every layer above may raise a `CrucibleError` without importing upward against the §1 dependency direction. *(Amended P1-02: relocated from `cli/errors.ts`, where P1-01 first placed it, once `config/` — the first non-cli thrower — surfaced the upward-import conflict. `cli/runner.ts` remains the sole place these map to process exit codes.)*

**Exit 1 is a verdict, not an error** *(settled P1-12)*: "checks ran and failed" (§2) is a successful command whose subject failed, so it is **not** a `CrucibleError` (deliberately typed `2|3|4`). `verify` renders its full report to stdout (or as `--json`), then throws the sentinel `CheckFailure { exit: 1 }` (`util/errors.ts`); `cli/runner.ts` maps it to exit 1 and prints nothing extra. A malformed artifact or a broken adapter is still a fail-closed `CrucibleError` (exit 3) — never downgraded to a red finding. The `VerifyReport` shape (`verifyx/report.ts`) is the zod-validated verdict JSON of §4.

## 4. Fail-closed conventions

- Parsers return typed results or throw `CrucibleError`; no partially-populated objects.
- Schema validation with zod at every trust boundary: artifact files, adapter JSON, verdict JSON, config files.
- Adapter `skip` status → `fail` for oracle-bound targets at the adapter-client layer (not left to callers).
- Unknown fields in enforcement config → exit 3 (typo'd glob keys must not silently no-op).

## 5. Naming conventions

- Files/dirs: kebab-case. Types/interfaces: PascalCase. No `I` prefixes.
- Artifact IDs per charter grammar: `REQ-<domain>-<slug>-<n>`, `ORC-<slug>-<seq>`, rubric `R-###`, tasks `P<phase>-##`.
- Command modules named exactly as the CLI verb (`commands/approve.ts`).

## 6. AgentSubstrate interface (frozen; settled P1-08)

Contract intent, unchanged since seed:
- Input: role (propose|implement|review), prompt/context payload, working dir, model id.
- Output: exit status, path to the session transcript (trajectory artifact), and nothing else — substrate output is never parsed for "did it succeed"; success is judged from artifacts it produced.

**Frozen shape (P1-08):** canonical machine form in `core/src/substrate/types.ts`.

- **Request:** `{ role, rolePromptPath, taskPayload, cwd, model, transcriptPath, timeoutMs? }`. The **caller mints `transcriptPath`** (convention `.crucible/transcripts/<change>/<role>-<ts>.jsonl`, owned by `commands/`): the substrate never invents paths, knows nothing of "changes", and holds no wall-clock naming — the audit-trail timestamp stays in the layer that already owns audit concerns. *(Amends the phase-0-1 §5 draft, which had the substrate computing this path.)*
- **Result:** `{ exitCode, transcriptPath }` — exactly two fields. Invariant 2 is enforced structurally: no success flag, no message, nothing parsed, nothing to trust. On every returned result the transcript file exists (possibly truncated if the run died mid-stream).
- **Returned vs thrown:** every outcome of a *started* run is **returned**, never thrown - non-zero exit, agent-side crash, or timeout (transcript preserved). `SUBSTRATE_UNAVAILABLE` exit 3 is reserved for inability to start: an unreadable role prompt or the selected `codex`/`claude` binary being unavailable. A dead author simply produced no trustworthy artifacts; downstream validation still fails closed.
- **Implementations (P3-10, amended P4-09):** `CodexSubstrate` runs isolated `codex exec --json --ephemeral` sessions in `workspace-write` by default. A host-incompatible nested sandbox may use `danger-full-access` only through explicit gitignored `.crucible/local.yaml` `agent.codex_sandbox`; there is no automatic fallback, and this convenience setting never reaches enforcement/CI. `ClaudeCodeSubstrate` runs headless `claude -p`. Provider-specific flags remain inside `substrate/`; shared process/timeout/transcript behavior lives in `process.ts`; `runtime.ts` is the sole command-layer provider and model resolver. `FakeSubstrate` remains the deterministic test double. Only `AgentSubstrate` and the request/result types are frozen.
- **Structured outputs generalize the caller-minted-path rule** *(P2-00 addendum)*: when a role must return structured data (e.g. the review verdict), the calling command mints a target path (convention `.crucible/verdicts/<change>/<role>-<ts>.json`, owned by `commands/` like transcript paths), names it in the taskPayload, and validates the file after the run — fail-closed. The substrate result is never widened; there remains nothing in it to trust.

## 7. Adapter wire contract (settled P1-11; resolve result amended P4-11; discovery environment amended P4-12)

Verbs `resolve`/`run` (+ optional `scope`), JSON over stdin/stdout, normalized result schema per charter §"Oracle File Syntax & Adapter Binding Spec". The TypeScript types in `core/src/adapters/types.ts` are the canonical machine form.

**Settled shape (P1-11):**
- **Request** (both verbs): `{ "targets": string[] }` written to the adapter's stdin.
- **Response** (both verbs): `{ "results": [...] }` on stdout, one entry per requested target. Two envelopes, zod-validated separately so a resolve-only status can't masquerade as a run status. Resolve is a strict discriminated union: `found → { target, status: "found", targetFile }`; `missing → { target, status: "missing", candidateFile? }`. `targetFile` is an existing project-relative file eligible for the approval seal. `candidateFile` is a contained, project-relative authoring location derived by the pinned adapter from runner-native target syntax and evaluated project configuration; it remains `missing` until ordinary discovery returns `found`. The core validates field/status combinations and containment, uses candidates only in pre-approval session handoffs, and ignores them for lint, seals, verify, and `why`. Run remains `{ target, status: "pass"|"fail"|"error"|"skip", message?, location?, duration_ms? }` (charter normalized schema exactly). Unknown fields, a `found` result without `targetFile`, a candidate on `found`, or a target file on `missing` → exit 3 (strict).
- **Discovery environment (P4-12):** an adapter that loads compiled targets must derive the discovery classpath from the build tool's evaluated test-execution model, preserving its entry order. Compilation and dependency resolution are permitted setup; executing a test goal/task or test body is not. A tool failure, malformed or partial model response, dependency-resolution failure, or linkage failure while loading an existing target is adapter failure, not `missing`. There is no compiled-output-only or best-effort fallback. This tightens adapter correctness without changing the wire schema.
- **Client** (`core/src/adapters/client.ts`) is the sole spawner (§1). It loads the manifest (`crucible-adapter.yaml`, `core/src/adapters/manifest.ts`), tokenizes the invocation string per verb, spawns the adapter as a subprocess, and dedupes the requested target set (one ask per target, first-appearance order).
- **ORC join:** `run(oracles[]) → OracleResult[]` joins each normalized result back to its oracle via the binding table. An oracle passes iff **every** bound target ran `pass`; any non-`pass` (incl. `skip` per invariant 4, `error`, or a target the adapter dropped) → the oracle's verdict is `fail`. The underlying per-target status is surfaced verbatim in `OracleResult.targets` for the trace; only the joined verdict is coerced. Results follow oracle input order and per-oracle binding order (invariant 12).
- **Fail-closed transport → exit 3** (`ADAPTER_TRANSPORT`, invariant 3): timeout, non-zero/killed exit, non-JSON stdout, schema-violating JSON, missing `results` envelope, or a dropped requested target. A broken judge never reports green.

## 8. Artifact operations API (frozen; settled P1, ratified P2-00)

`artifacts/` exposes typed load/validate functions per artifact kind; commands never read artifact files directly. As-built P1 surface, now frozen: `parseProposal`/`loadProposal`, `parseOracles`/`loadOracles`, `parseSpecDelta`/`loadSpecDelta`, and approval sealing (`sealBundle`, `verifyApproval`, `parseApproval`/`serializeApproval`, strict `approvalSchema` with the `amendments[]` array). All parsers throw `CrucibleError` exit 3 on malformed input (§3–4); the strict `state/state.ts` parser vs. tolerant `state/reconcile.ts` split (P1-14) is part of the contract — no enforcement path may accept a broken log. Phase 2 *adds* kinds (escalation, override, rubric, verdict) under the same rules; it does not reshape the P1 surface.

## 9. Testing contract

- Framework: vitest. Unit tests colocated (`*.test.ts`); integration tests in `core/test/` run against `fixtures/toy-repo`.
- TCB modules (hash, lint, tier, artifacts parsers, adapter client, verdict parsing) require malformed-input cases in every suite.
- The tracer integration test (P1-16) is the permanent end-to-end regression anchor; it must stay green from Phase 1 onward.

## 10. Session-native authoring (ratified P4-10, 2026-08-03)

Session-native authoring is a second **local execution mode**, not an `AgentSubstrate` implementation and not a relaxation of §6. An already-active Codex or Claude Code session performs the nondeterministic writing; deterministic CLI subcommands own every preflight, scaffold, handoff, checkpoint transition, validation, and verdict. Direct `crucible propose` / `implement` retain the headless substrate path for automation.

### Role matrix

| Role or command | Session-native skill | Headless path |
|---|---|---|
| propose create + pre-approval revise | Initial release; no child agent | Retained |
| implement (tasks first, then code) | Initial release; no child agent | Retained |
| review | P4-20; separate fresh interactive session | Headless `AgentSubstrate` retained |
| amend + approve-time regeneration | P4-21; no child agent | Existing fresh propose role retained |
| approve / verify / escalate / override / archive / status / why | Thin pinned-CLI skills only | Deterministic or existing behavior |

### Public CLI and handoff contract

The session surface is:

```
crucible session status <change>
crucible session propose start <change> <intent> [--type feature|bugfix|refactor]
crucible session propose next|resume|finish <change>
crucible session propose revise <change> <instruction>
crucible session implement start|tasks-ready|resume|finish <change>
crucible session amend start <change> <resolution>
crucible session amend next|resume|finish|seal <change>
```

Every successful stage emits strict JSON `SessionHandoffV1`: `{ version: 1, change, role, operation, stage, change_dir, role_prompt, instructions[], next_command, input_hash }`. Unknown or missing fields fail exit 3. `session status` emits artifact-derived phase plus an allow-list of exact next commands; the hub skill may display only that list. Human-readable output may render the same object, but skills use `--json`.

Gitignored `.crucible/sessions/<change>/<role>.json` checkpoints persist only explicit CLI inputs and the current stage. Propose stages are `scaffolding → artifacts → oracle-tests → ready`; every command re-derives the applicable stage from artifacts plus adapter results before updating the checkpoint. `input_hash` seals the relevant inputs (propose operation/type/intent; implement approval bytes). They make interruption recovery deterministic but are **not enforcement artifacts**: approval, hash scope, tier, verify, review, routing, archive, and CI have no dependency on `session/`. Missing checkpoints teach the exact restart command; malformed checkpoints exit 3; stale input hashes exit 2 and name the required restart/amend action. P4-10 v1 `authoring` checkpoints are accepted once and migrated by re-derivation so in-flight validation changes remain resumable. Deleting or forging a checkpoint can at worst disrupt local guidance—it cannot produce a valid bundle, approval, verdict, or merge.

### Propose lifecycle

1. `start` validates name, intent, type, role prompt, and absence of an existing change; records the deterministic create handoff; then scaffolds through Crucible's packaged, pinned OpenSpec runtime with the type-specific schema. A failed scaffold is resumable from the recorded input and is never treated as success.
2. `next` revalidates the checkpoint and asks the packaged OpenSpec runtime for status plus the next ready artifact instructions. It validates and returns only pre-approval bundle paths (`proposal.md`, `specs/**`, `design.md`, `oracles.md`); an upstream `tasks.md` instruction is an apply-stage signal, never a proposal write authorization. Once no pre-approval artifact remains, the CLI parses `oracles.md`, batches ordinary adapter `resolve`, and groups every `missing` result with a `candidateFile` into exact oracle-test instructions (multiple targets may share one file). A missing result without a safe candidate exits 2 naming the binding and exact `propose revise` recovery. When every target is `found` with a `targetFile`, the derived stage is `ready`. `resume` performs the same derivation after interruption. Neither command trusts conversation history or OpenSpec's completion claim.
3. `revise` requires an existing unapproved change, records the explicit revision instruction, and returns the dependency-ordered pre-approval regeneration handoff; it never returns `tasks.md`. After those files are written, `next`/`resume` re-derives affected oracle-test instructions. Approved changes still require `amend`.
4. `finish` independently rejects a pre-approval `tasks.md`, then runs Crucible bundle parsing, type conformance, adapter binding resolution, and traceability lint. Red is exit 1 with the checkpoint retained for fixes/retry; malformed trusted inputs are exit 3. Green requires every bound target to be genuinely `found` with its existing `targetFile`; only then does it stamp `generation.yaml`, append `execution_mode: session-native` audit provenance, and expose `approve` as next. Headless `propose` and `approve` apply the same pre-approval `tasks.md` rejection so execution mode cannot change the gate.

The Crucible propose skill is therefore **not** a wrapper around OpenSpec's `openspec-propose` skill: that upstream workflow creates `tasks.md` before approval and does not enforce Crucible oracles or seals. Only the pinned Crucible CLI may call OpenSpec's scaffold/status/instructions primitives.

### Implement lifecycle

1. `start` requires an existing change, parseable and valid approval seal, role prompt, and no unresolved escalation. It records the approval-file hash and emits only the tasks-stage handoff, even when an old `tasks.md` exists.
2. `tasks-ready` revalidates the same approval hash and requires a non-empty `tasks.md` before moving the checkpoint to implementation. `resume` revalidates artifacts and returns only the current stage's handoff.
3. `finish` requires the implementation-stage checkpoint, independently revalidates approval/tasks/escalation, and runs ordinary local `verify`. A pending escalation exits 2 naming `amend`; red verify exits 1 and remains resumable; green records session-native provenance. Any sealed-file edit is caught by the unchanged approval check.

### Skills, launcher, permissions, and audit

`init` owns one hub plus command-specific `SKILL.md` assets for `crucible`, propose, approve, implement, verify, review, amend, escalate, override, archive, status, and why. It installs the portable `name`/`description` subset under both `.agents/skills/<name>/` (Codex) and `.claude/skills/<name>/` (Claude Code), validates metadata before writing, and uses the existing idempotent diff-and-confirm policy so human bytes outside managed regions are preserved.

Every installed skill calls `node .crucible/bin/crucible.mjs`; none calls an ambient `crucible`. `init` generates that gitignored local launcher from the source checkout used for initialization. Each call strictly loads `.crucible/framework.lock.json`, verifies the checkout's normalized GitHub repository and `HEAD` against the pin, verifies the built CLI exists, then delegates without fallback. A missing launcher/check-out/build is exit 2 with the exact `init` recovery; a malformed or mismatched pin is exit 3. This is advisory local provenance on an untrusted developer machine; CI continues to check out and build the target branch's exact pin independently.

Interactive filesystem/shell permissions are selected and enforced by the host Codex/Claude surface. No Crucible enforcement or convenience setting broadens them, and a permission denial is an interrupted local stage—not a reason to fall back to P4-09's `danger-full-access`. Session checkpoints and `state.yaml` are audit/convenience only. Session-native state events set `execution_mode: session-native` and omit a Crucible transcript path; headless events set `headless` and retain their caller-minted transcript. Neither field is an enforcement input.

## 11. Detached CI reviewer transport (ratified P4-14, 2026-08-10)

The credentialed CI reviewer is a distinct transport for the existing review contract, not an `AgentSubstrate` implementation and not a session-native reviewer. Local `crucible review` and `verify --review` retain architecture §6 unchanged. In CI, the nondeterministic agent may propose only a verdict; pinned core remains the judge and branch protection requires its result.

### Workflow and trust boundaries

1. The ordinary `pull_request` workflow runs the project and deterministic `verify` checks with no reviewer credential. It never receives `OPENAI_API_KEY` or another review secret.
2. A maintained `pull_request_target` workflow is loaded only from the target branch. Its preparation job fetches base and head as data, builds the target branch's pinned Crucible framework, and emits a bounded review request without checking out or executing PR-controlled code.
3. A credentialed review job runs the official OpenAI Codex GitHub Action as its final step. The action/CLI version and reviewer model are pinned by the target-branch workflow; `openai-api-key` is passed only to the action, `safety-strategy: drop-sudo` and `permission-profile: :read-only` are mandatory, and project commands, tests, hooks, dependency installation, network tools, and PR-owned instructions are unavailable.
4. A separate credential-free job passes the returned bytes to pinned core. Core alone validates and publishes the `review` required check. `verify`, `review`, and `route` are jointly required by branch protection; no workflow result substitutes for another.

The action receives a clean runner-temporary working directory and a trusted target-branch developer prompt. The request contains normalized diff and artifact text as explicitly delimited untrusted data; it does not expose a PR checkout, project `AGENTS.md`, repository tools, or the API credential. Any path traversal, symlink, oversize input, malformed git object, or inability to obtain the exact base/head data aborts preparation.

### Bound request and verdict

- Target-branch core independently validates each bundle and seal, then mints a canonical request containing repository identity, pull-request number, base SHA, head SHA, exact change-name set, per-change approved artifacts, normalized diff, rubric bytes/hash, prompt hash, and a request hash over the envelope. Input is capped at 2 MiB total, 1 MiB for the normalized diff, and 256 KiB per artifact; the schema-constrained verdict is capped at 256 KiB. Oversize is a framework error, never truncation. PR prose never supplies workflow instructions.
- The action is constrained by a target-branch JSON Schema. A multi-change PR produces one strict batch envelope with exactly one existing review verdict per requested change; this wraps rather than weakens the P2 verdict schema.
- Credential-free core requires byte-for-byte bindings to the expected base SHA, head SHA, change-name set, rubric hash, prompt hash, and request hash. Missing, duplicate, extra, stale, unknown-field, schema-invalid, or inconsistently bound results fail closed.
- Existing enumerated-blocking remains law: unknown rubric IDs, `fail` without a block finding, or any other P2 verdict inconsistency are red. Agent exit status, final-message prose, model self-report, action success, and GitHub comments are never evidence of review success.
- The repo secret name is fixed as `OPENAI_API_KEY`. Missing/empty credentials, action denial or failure, timeout, missing output, schema mismatch, or unavailable pinned tooling make the required `review` check red; there is no skip, warning, local verdict reuse, or mechanical-verify fallback.
- The initial v2 validation transport is Codex-only and target-branch-pinned. `.crucible/settings.yaml` remains convenience input for local headless review and cannot select the CI provider, model, versions, permissions, schema, or failure policy.

### Trigger and actor policy

The detached workflow uses `pull_request_target` solely to obtain a target-branch-owned workflow and repository secret without granting that secret to PR execution. It must never check out the PR head, run a PR workflow/script, install PR dependencies, or pass the secret at job scope. The action's default write-access actor restriction remains in force; `allow-users: "*"` is forbidden. A fork or untrusted actor that cannot receive the secret fails closed. A separately ratified maintainer-approval/re-run flow for external contributors is out of P4-14 scope.

Official OpenAI guidance is part of the implementation constraint: use `openai/codex-action` with an API key for automation, keep the key scoped to the action rather than job environment, drop sudo, run read-only, and make the action the credentialed job's last step. The action reference is pinned to an immutable commit and `codex-version` to an exact version so mutable upstream tags cannot change enforcement silently.

### Rollout and failure recovery

1. Merge the framework implementation under the existing harness; no product bypass is permitted.
2. Update a product's framework pin and generated workflows in an isolated PR containing no governed change bundle. The old target-branch workflow judges that pin bump.
3. Configure `OPENAI_API_KEY`, install required checks `verify`, `review`, and `route`, and confirm the detached reviewer on a harmless validation PR.
4. Only then re-run preserved product changes. A failed reviewer transport is fixed in the framework or repository setup; it is never bypassed by approving the product bundle, weakening the rubric, or disabling review.

This amendment supersedes P2-10 only where it says the shipped CI workflow supplies `VerifyDeps.review` inside `verify --review`. Local behavior, the fresh-review requirement, the verdict schema/evaluator, rubric law, and observations semantics remain unchanged. CI review transport is now detached to keep the credential outside every job that executes untrusted project code.

## 12. Explicit advisory CI-review mode (ratified P4-15, 2026-08-10)

P4-15 permits a temporary, deliberately weaker validation posture without weakening deterministic verification. Target-branch `crucible.yaml` owns `review.ci_mode: advisory|required`. The field is strict; unknown values fail closed, and absence defaults to `required`, so existing projects never silently lose review.

The detached workflow begins with a credential-free policy job using target-branch pinned core and config. In `required` mode P4-14 is unchanged: prepare, credentialed action, and secretless judge run; missing credentials or any transport/verdict defect is red; branch protection requires `verify`, `route`, and the judge. In `advisory` mode reviewer jobs are not scheduled, no secret is read, no agent call is made, and no verdict/check success is synthesized. The policy job reports `CI_REVIEW_ADVISORY: no CI adversarial reviewer ran`; branch protection requires only `verify` and `route`.

Mode selection never depends on secret presence, repository variables, PR config, convenience settings, local state, or an agent report. Local `verify --review` is useful feedback but non-authoritative. Oracle and regression execution remain in the ordinary credential-free workflow and are identical in both modes.

Enabling is ordered: create `OPENAI_API_KEY`; merge a dedicated risk-routed target-config PR changing `advisory → required`; validate detached review on a harmless PR; then add its judge check to branch protection. Disabling reverses the authority edge: remove the judge requirement first, then merge `required → advisory`. A branch-protection/config mismatch is an operational misconfiguration, never a reason to infer a mode.


## 13. Framework source-pin upgrade lane (ratified P4-16, 2026-08-10)

The exact-pin launcher creates an intentional authority edge: the currently pinned checkout drives ordinary work, while a candidate checkout may be invoked directly only for the explicit `init` bootstrap that stages its own pin and managed bytes. Treating that bootstrap as a product proposal is both circular and dishonest—a product oracle cannot establish that its judge is trustworthy, and running candidate `init` first would make the supposed oracle green before approval.

Framework upgrades therefore use the P4-14 no-governed-change path. From a clean target branch, the operator runs candidate `init`, accepts only understood managed-file differences, and opens one isolated human-reviewed PR. Its committed diff is limited to `.crucible/framework.lock.json` plus candidate-`init` managed harness bytes that actually changed. It contains no `openspec/changes/**`, product source/test bytes, `crucible.yaml`, settings/local config, or unrelated edits. The gitignored launcher is local bootstrap state and never merge evidence.

After P4-24, CI loads the executable mechanical workflow and enforcement inputs from the old target branch. The pin PR cannot activate its proposed workflow or policy for itself. Before P4-24, GitHub's `pull_request` trigger loaded candidate workflow bytes, so the stronger historical wording was inaccurate; the P4-24 pin is the final explicitly reviewed legacy bootstrap. The framework commit must already be reachable from the declared repository and green in the framework repository; the product PR retains target-pinned deterministic checks and explicit human approval. Any missing pin, unexpected generated diff, mixed product/config edit, unavailable required check, or mismatch between generated bytes and the candidate checkout stops the rollout. It is never converted into a product oracle, a fake review pass, or an ambient-CLI fallback.

After merge, collaborators rerun `init` from the now-pinned checkout to refresh their local launcher. Enforcement changes follow separately under the new target-branch framework. For the P4-15 required-to-advisory transition, remove the detached judge from branch protection before the pin PR, keep any old missing-credential result visibly red rather than manufacturing success, merge the isolated pin, then merge the separate risk-routed `review.ci_mode: advisory` PR. `verify` and `route` remain required throughout.

## 14. Durable approval tier floor (ratified P4-17, 2026-08-10)

Approval and verification share one pure tier function but observe the diff at different times. Approval normally sees the proposal artifacts and pre-implementation oracle tests; CI sees the completed implementation. A planned risk-path edit can therefore be absent from approval's facts even though it must receive critical ceremony. P4-17 carries the existing force-up contract across that time boundary.

`approve --tier <tier>` strictly parses a tier name and supplies it to the ordinary maximum-based computation. The resulting effective tier controls the rendered gate, refuses `--yes` when critical, and is serialized as optional `approval.yaml.minimum_tier`. New approvals produced with authoritative config and diff facts always write the field; its omission is accepted only for compatibility with existing approvals. The schema remains version 1 because the field is optional and old approval semantics are unchanged.

`verify` loads the approval before tiering and computes:

```text
effective tier = max(final fact-based tier, approval.minimum_tier if present)
```

The floor comes from the change branch but can only increase ceremony, tighten the diff cap, and force human routing. Risk globs, exemptions, caps, and final diff facts remain target-branch-owned in CI. A PR cannot use the field to mask a risk match or select a lower cap regime.

Critical ceremony is a relational approval invariant rather than audit-only metadata. Whenever the effective tier is critical and an approval exists, `acks` must contain each current oracle ID exactly once and no unknown ID. Missing, duplicate, or extra acknowledgments make the approval check red; malformed fields remain exit 3. This also detects a standard approval whose later implementation unexpectedly enters a risk path. Critical changes with no current oracles still require the interactive confirmation, while the exact required acknowledgment set is empty.

The approval hash scope is unchanged. An enforcement-config change is ordinary governed implementation only when the sealed proposal/spec/design/oracle bundle explicitly specifies it and the approval records a critical floor. `crucible.yaml` itself is not added to that seal: its proposed bytes are the implementation under judgment, and CI deliberately evaluates the PR using the target branch's config. Direct config-only PRs, pre-approval config edits that make the oracle green, and P4-16's bootstrap lane remain invalid substitutes.

## 15. Explicit review posture and local review loop (ratified P4-18/P4-19, 2026-08-10)

Dogfooding exposed a legitimate single-maintainer deployment shape: the project may deliberately decline paid PR-agent review and may have no second GitHub identity capable of satisfying the critical-tier non-author approval gate. This is a policy choice, not a missing-credential fallback. P4-18 therefore separates three controls that earlier text coupled: deterministic verification, PR AI review, and independent human approval. Deterministic verification remains mandatory in every posture and continues to execute current oracles, the full CI regression suite, traceability, approval seals, diff caps, and tier computation.

### Target-branch PR policy

Target-branch `crucible.yaml` owns two strict, independent fields:

```yaml
review:
  ci_mode: advisory|required
  human_mode: advisory|required
```

Absence of either field means `required`, preserving existing projects. Unknown, null, duplicate, or wrong-typed values fail closed. Neither field is inferred from `OPENAI_API_KEY`, repository variables, contributor identity, convenience config, local verdicts, or agent output. `ci_mode: advisory` retains P4-15 semantics: no PR reviewer is scheduled and no verdict is manufactured. `human_mode: advisory` retains tier/routing computation and reports every human-routing reason, but does not install a blocking GitHub `route` job. It is a consciously weaker solo-maintainer posture, never rendered as independent approval.

The generated check matrix is exact:

| `ci_mode` | `human_mode` | PR checks installed by Crucible |
| --- | --- | --- |
| `required` | `required` | `verify`, detached review judge, `route` |
| `advisory` | `required` | `verify`, `route` |
| `required` | `advisory` | `verify`, detached review judge |
| `advisory` | `advisory` | `verify` only |

The omitted checks are absent, not successful/skipped substitutes. Target-branch managed workflow bytes must agree structurally with the target-branch config; pinned core rejects a missing required job or an installed disabled job before ordinary verification can turn green. `doctor` reports the same mismatch locally. GitHub branch-protection/ruleset configuration remains an external operator action: `init` prints the exact required-check set but does not consume a token or mutate repository settings. A stale external required check blocks operationally and is never interpreted as a framework pass.

Tier and routing facts do not change. Critical changes still compute `routing: human`; the report additionally carries the configured human-review enforcement posture and warns conspicuously when that recommendation is advisory. P4-17 critical oracle acknowledgments remain mandatory. An `override.yaml` is not usable in advisory-human mode: override is an emergency bypass whose settled contract requires independent human review, so verify fails closed until `human_mode: required` and its route job are restored.

`crucible init` asks explicitly for PR AI-review and independent-human-review modes. It never asks for, probes, or stores an API key. Non-interactive `--yes` retains the backward-compatible safe defaults (`required`/`required`). Selecting required CI review prints the separately performed `OPENAI_API_KEY` and branch-protection setup; selecting advisory omits the detached PR workflow. Re-running init/doctor renders and checks the selected workflow variants idempotently with the existing diff-and-confirm ownership rules.

Because workflows and enforcement are target-branch-owned, a policy PR cannot disable its own old gate. Moving to solo posture is ordered: remove only the soon-to-be-disabled external required checks; merge an isolated framework-pin/managed-workflow update under the remaining old checks; then merge a separately governed, critical-floor config PR carrying both desired modes and generated workflow bytes. The old target policy judges each transition PR. No red check is converted to green, and no current PR may claim the new posture before it reaches the target branch.

### Fresh local reviewer lifecycle

P4-19 makes local adversarial review a first-class session stage while preserving architecture §6: the reviewer is a fresh `AgentSubstrate` role, never the already-active implementing session. “Independent” means separate context, role prompt, and preferably model family; it does not mean organizational independence and does not make a developer-machine verdict CI evidence.

Team convenience config owns `review.local_mode: required|advisory|off` in `.crucible/settings.yaml`; a personal local override may select the same values. This setting can shape only local handoffs. It cannot affect verify's CI verdict, tier, routing, generated workflows, or branch protection. Omission preserves the existing advisory behavior. Interactive init offers the choice; the recommended solo profile writes `required`, while `--yes` remains backward compatible.

When local mode is required, session-native implementation advances `tasks → implementation → review-pending`. A green mechanical local verify is required before `review-pending`, but it does not complete the session. The handoff requires the intended branch diff to be committed; staged or tracked working-tree edits fail the review precondition, while untracked files are explicitly reported as excluded because they are not part of the proposed commit. The fresh reviewer judges the canonical `merge-base...HEAD` diff against the sealed bundle and current rubric. Its verdict and the checkpoint bind base SHA, HEAD SHA, approval hash, rubric hash, and verdict-file hash. A changed HEAD, approval, rubric, or diff invalidates the result and requires a fresh review.

A green fail-closed verdict advances to `reviewed` and exposes final `crucible verify`. A red, missing, malformed, stale, or rubric-invalid verdict advances to `review-red`; it never launches implementation automatically. After reading the cited rubric findings, the human explicitly runs the review-address transition, which returns the session to `implementation` with exact instructions permitting updates only to `tasks.md` and unsealed implementation files. The implementer fixes and recommits, mechanical verify runs again, and a new fresh reviewer judges the new snapshot. Sealed artifacts or bound tests still require ordinary `amend` and reapproval. There is no self-reported pass, automatic agent-to-agent loop, committed local verdict, or reuse of a local verdict in CI.

Advisory local mode offers the same review path but permits an explicit skip recorded only in the audit trail; off mode retains the present implementation-to-verify handoff. A local reviewer failure remains visible and actionable but cannot itself weaken deterministic verification. The initial P4-18/P4-19 rollout ships both tasks before a product selects `human_mode: advisory`, so the recommended solo posture never arrives without the local independent-review loop it relies on.

## 16. Session-native fresh reviewer transport (ratified P4-20, 2026-08-10)

Notes dogfooding proved that P4-19's child Codex transport is not portable on the validation host: the fresh reviewer recovered enough to inspect its work order, but every caller-minted verdict write failed under nested Bubblewrap with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. The strict evaluator correctly returned `NO_VERDICT`; the framework must preserve that red result while changing the local transport rather than granting `danger-full-access`, selecting another provider, or accepting agent prose.

For a session-native implementation, required local review now uses a second session-native role. `implement finish` still performs green mechanical verify and requires a committed, tracked-clean snapshot, then stops at `review-pending`. The implementing skill tells the human to open a fresh interactive session and invoke the init-managed `review` skill. That skill calls only the pinned launcher; it never starts `codex exec` or another child agent.

The review lifecycle is CLI-owned:

1. `session review start <change>` requires `review-pending`, a valid current approval, a computable merge base and HEAD, and no staged or tracked dirty bytes. It computes the approval and rubric hashes, mints a contained gitignored verdict path, writes a strict local review checkpoint, and returns a `role: review` handoff naming the role prompt, exact base/HEAD diff, approved bundle, rubric, and verdict path.
2. The fresh interactive reviewer may read those named inputs and write only the caller-minted verdict artifact. Conversation text, skill completion, transcript text, model identity, and arbitrary files remain non-evidence.
3. `session review finish <change>` reloads the checkpoint, recomputes base, HEAD, approval, and rubric bindings, parses the verdict with the existing strict evaluator, hashes the verdict bytes, and only then advances the implementation checkpoint to `reviewed`. Any missing, malformed, stale, unknown-rubric, inconsistent, or changed-snapshot outcome advances to `review-red` and returns the exact structured findings.

The managed review skill is deliberately low-freedom: it checks the CLI handoff, instructs the reviewer to stop if the conversation authored the implementation, reads `.crucible/context/review.md`, writes the exact verdict schema, invokes `session review finish`, and stops on red. The human-enforced fresh-conversation boundary is adequate because this result is local convenience evidence, not CI authority; pinned core still refuses to trust self-report. A user who ignores that ceremony weakens only their local process and cannot alter verification, tiering, routing, or merge checks.

Headless `crucible review` remains the explicit child-`AgentSubstrate` command for automation and is not silently redirected. The detached CI reviewer is unchanged. There is no automatic fallback between transports. A red verdict with block findings still requires `review-address` before implementation edits. An infrastructure-only or missing-verdict red may be retried only through an explicit human `session implement review-retry` transition that preserves the unchanged committed snapshot and remints a new one-use verdict path.

Existing P4-19 checkpoints migrate by revalidation, never by trust. `review-pending` can start the new review lifecycle. A legacy `review-red` checkpoint carries no trustworthy failure detail, so the human must explicitly choose `review-retry` or `review-address`; neither choice creates a pass. An approved consumer branch cannot update its sealed framework lock in place: merge the framework fix, use the isolated target-branch pin rollout, then restart/reapprove the affected product change from the new pin rather than hand-editing its approval.

## 17. Session-native amendment (ratified P4-21, 2026-08-10)

Notes dogfooding exposed both remaining assumptions in the headless-only amendment path. A legitimate post-approval `tasks.md` made the shared bundle judge report “tasks are authored only after approval,” and after that file was moved aside the fresh propose-role Codex subprocess failed under the same nested Bubblewrap restriction that motivated P4-10 and P4-20. The subprocess produced no trusted regeneration, so core correctly left the old seal unchanged. The operator rejects `danger-full-access`; the repair is an explicit session-native amendment transport plus a phase-correct tasks rule, not a sandbox fallback or manual seal edit.

Session-native amend is an authoring role, not an independent review role. It may run in the already-active interactive session because the human's subsequent re-seal remains the authority edge. The role reads the propose prompt and receives only CLI-minted instructions. It cannot approve itself, choose the hash scope, clear an escalation, or advance implementation. Headless `crucible amend` remains a distinct automation path through `AgentSubstrate`; neither transport silently falls back to the other.

### Lifecycle and checkpoint

1. `session amend start <change> <resolution>` requires a non-empty resolution, an existing valid approval, a parseable change type and role prompt, and a parseable escalation when one exists. It snapshots the exact approval bytes/hash, resolution, escalation bytes/hash-or-absence, original sealed file map, and the implementation checkpoint identity when present. It refuses a second live amendment. The returned `role: amend` handoff names only proposal/design/spec/oracle paths and the currently sealed bound-test paths; it never names `tasks.md`, approval, generation, state, config, or implementation files.
2. `next` and `resume` revalidate those bound inputs. They derive dependency-ordered artifact work from the packaged OpenSpec runtime while filtering `tasks.md`, then use ordinary adapter `resolve` to return exact safe candidate paths for newly introduced bound tests. An unresolved target without a contained candidate fails closed and teaches artifact revision. A candidate remains red until a later resolve returns `found` with an existing target file. Existing implementation files and `tasks.md` may already differ from the merge base, but the amendment handoff never authorizes changing them.
3. `finish` requires the amendment checkpoint, unchanged approval artifact, unchanged resolution/escalation binding, complete artifacts, and every binding grounded. It judges the bundle in post-approval mode: a present `tasks.md` is excluded from the bundle and hash scope rather than rejected. Red or malformed output re-seals nothing, clears nothing, and keeps a resumable checkpoint. Green records a ready-to-seal checkpoint plus the newly derived hash scope and returns only `session amend seal`.
4. `seal` is an interactive human edge, not an agent-authoring handoff. It recomputes every start/finish binding and reruns the full judge immediately before rendering the exact old-seal-to-current-scope diff. Decline writes nothing and leaves the checkpoint ready. Confirmation appends one ordinary `approval.amendments[]` entry while updating live hashes, re-stamps `generation.yaml`, clears only the bound escalation, records audit provenance, invalidates obsolete local-review evidence, and removes the amendment checkpoint. Any implementation checkpoint restarts at `tasks` against the new approval; the next action is `session implement start`.

The checkpoint lives at `.crucible/sessions/<change>/amend.json` and is convenience/audit state only. Its strict schema and input hash make interruption recovery deterministic, but it is not accepted as proof of approval or regeneration. Deleting it after sealed bytes change cannot legitimize those bytes: ordinary approval verification stays red, and a new `start` refuses because the old seal no longer validates. Malformed, path-traversing, stale, mismatched-change, or forged-stage checkpoints exit 3 or 2 without sealing.

### Phase-aware tasks rule and write boundary

“Tasks are authored only after approval” is a phase rule, not a universal bundle-shape rule. Pre-approval propose (headless and session-native) plus first approval still reject any `tasks.md`. Both headless and session-native amend first prove that a valid approval existed, then invoke bundle judgment in an explicit post-approval mode that ignores `tasks.md`; no caller may infer that mode merely from file presence. `tasks.md` stays outside `computeHashScope`, amendment diffs, generation ordering, and the managed amend skill's allowed paths. Malformed or missing artifacts, approvals, bindings, and adapter output remain fail-closed.

The CLI compares tracked and untracked project bytes at `finish`/`seal` with the amendment's derived write set. Pre-existing implementation dirt may remain byte-identical, allowing escalation recovery mid-implementation; any new change outside current/previous sealed paths, exact adapter candidates, and CLI-owned checkpoint/state files fails with the offending paths. This boundary is local process protection, not merge evidence. The approval seal, immutable bound tests after re-seal, deterministic verify, and target-branch CI remain the enforcement boundary.

## 18. Enforcement diff facts exclude derived state (ratified P4-22, 2026-08-10)

Notes P4-21 dogfooding proved that the shared git edge currently contradicts the charter State & Audit law. A critically approved policy diff reached 419 lines, was amended and independently reviewed twice, yet remained at 415 because each mandatory reseal/reimplementation/review cycle appended committed `state.yaml` events. The cache thereby affected diff-cap enforcement even though no enforcement path is allowed to trust it.

P4-22 corrects only the shared `computeDiffFacts` boundary used by approve, verify, and CI. Its public result contains enforcement-effective facts:

1. Obtain the canonical merge-base-to-HEAD name and numstat data from git. Missing history, command failure, truncated/malformed records, invalid counts, or inconsistent records remain exit 3. Binary `-` counts retain the existing zero-line treatment.
2. Classify only `openspec/changes/<change>/state.yaml` and `openspec/changes/archive/<entry>/state.yaml` as derived state. Matching is repository-relative, POSIX-normalized, case-sensitive, and exact; extra nesting, alternate names/extensions, and traversal forms are not excluded.
3. Remove exact derived-state paths from `touchedPaths` and omit their added/deleted counts from `diffLines`. Risk matching, tier computation, cap enforcement, routing, and reports consume only these effective facts.

The filter does not rewrite or ignore files in git, approval hashing, amendment write-boundary checks, status reconciliation, raw review diffs, or archival history. It creates no configurable exemption and accepts no agent-supplied path list. All non-state change artifacts and product/harness bytes remain counted. A state-only diff therefore has zero enforcement paths and zero lines, while a mixed diff is judged exactly as if its derived state rows were absent.

This is a correction to invariant 1, not a weaker cap. The state parser, append-style event behavior, command-supplied deterministic timestamps, and fail-closed artifact checks remain unchanged. P4-21 seal and fresh-review lifecycle also remains unchanged; repeated audit events simply cease feeding back into its enforcement budget.

## 19. Complete target enforcement snapshot (ratified P4-23, 2026-08-15)

P4-18 made review-policy/workflow congruence an enforcement precondition, but the shipped CI transport continued to extract only `crucible.yaml` and the framework lock into the `--config-from` directory. Local verification saw the repository workflows and passed; CI saw an incomplete directory, classified both managed workflows as missing, and returned `REVIEW_POSTURE_DRIFT` even when the target branch's workflow blobs were byte-identical to the pinned templates. Notes PR #18 is the first consumer proof of that transport mismatch.

`--config-from` therefore denotes a target-owned enforcement snapshot with this fixed layout:

```text
<snapshot>/crucible.yaml
<snapshot>/.crucible/framework.lock.json
<snapshot>/.github/workflows/crucible.yml
<snapshot>/.github/workflows/crucible-review.yml   # only when present on target
```

The CI template fetches one explicit `origin/<base_ref>` commit and materializes every entry from that same commit beneath `RUNNER_TEMP`. The main workflow is required. The review workflow uses an exact tree-membership query so target absence is represented by absence in the snapshot; if present, its bytes must be extracted successfully. The extraction never copies from the checked-out PR, never follows worktree symlinks, never synthesizes an empty or passing workflow, and never parses policy in shell to decide the expected shape. Pinned core remains the sole congruence judge after loading target config.

The strict judge API remains a deterministic root-plus-config comparison. Local commands pass the repository root; CI passes the complete snapshot root. Missing mandatory inputs, unexpected optional presence, byte differences, invalid Git entries, incomplete history, and tool failures are errors rather than drift suppression. This preserves invariant 7 across both the policy bytes and the managed enforcement mechanism that realizes them.

Rollout remains two-stage. First merge a P4-16-isolated framework-pin plus generated managed-workflow refresh under the old target harness; a bootstrap PR contains no product/config/change-bundle bytes. Then restart and critically approve the ordinary posture change from the new target pin. An existing approval that seals the old framework lock is evidence only and cannot be updated in place.

## 20. Target-owned executable CI contract (ratified P4-24, 2026-08-15)

Notes PR #19 exposed both a local defect and a missing integration boundary. P4-23 wrote the framework lock to `<snapshot>/.crucible/framework.lock.json`, but the next generated step read `<snapshot>/framework.lock.json`. The ratified P4-23 real-Git consumer, worked verification, and bootstrap tests were not implemented; substring tests proved only that the producer contained the new path. All framework tests therefore passed while the first generated consumer failed before checkout of the pinned framework.

The correction has three coupled edges.

1. **Base-owned workflow authority.** The main managed workflow uses `pull_request_target` plus `pull_request_review` and is therefore loaded from the pull request base. It binds `BASE_SHA` and `HEAD_SHA` from the event, checks out only the exact head for the mechanical job, uses `persist-credentials: false`, and has no secret, issue-write, or pull-request-write permission. The job may execute candidate code only through the sealed deterministic/oracle path. A separate route/ratchet job reads candidate bytes as data, builds only the target-pinned framework, and never runs project commands, hooks, dependencies, tests, agents, or PR-owned instructions.
2. **Atomic bootstrap handoff.** A single bootstrap step, after a pinned Node runtime is available, fetches the exact event SHAs, creates a fresh snapshot under `RUNNER_TEMP`, validates canonical `100644 blob` entries, materializes config/lock/workflows, parses the nested lock with the shared strict schema contract, and emits `snapshot`, `repository`, `commit`, `base_sha`, and `head_sha`. Checkout, verify, posture congruence, and deterministic route computation consume only these outputs. No literal `crucible-target/framework.lock.json`, reconstructed snapshot root, mutable `origin/<branch>` decision input, or PR-tree fallback remains.
3. **Executable release qualification.** A real-Git workflow-contract harness parses the exact shipped YAML and executes its bootstrap and consumer scripts with GitHub control-file semantics. It covers both templates, all review postures, target-only optional-workflow presence, hostile PR replacements, exact outputs, no-change bootstrap, governed single/multi-change routing, and the complete malformed/tool-failure matrix. A worked initialized consumer then runs pinned core far enough to prove posture preconditions and ordinary oracle verification are reached. Framework CI treats these tests like package determinism: omission or failure blocks delivery.

The trusted route computation is a deterministic core command over exact base/head diff facts, parsed bundle/type/approval facts, target enforcement config, and override presence. It aggregates `human` if any touched governed change requires it, returns `auto` for an exact no-change P4-16 bootstrap, and fails closed on malformed bundles, approvals, diffs, or missing history. It does not run adapters or accept a routing value from the mechanical job. The route job performs any review query and override issue filing only after this recomputation.

The detached credentialed reviewer remains the P4-14 target-owned workflow and is not merged into mechanical verification. Stale mechanical `--review` comments and observation-posting code are removed so the workflow describes what it executes. No policy mode, tier, seal, oracle, skip, or secret behavior is weakened.

## 21. Release-qualified consumer authority (P4-25, ratified 2026-08-15)

P4-24's merged shape contains three authority boundaries where convenience behavior leaked into enforcement: the workflow shell discovers only changed bundles and calls success for every empty set; the shared `verify`/`route` cores treat a missing approval as a legitimate pre-approval invocation; and full `init` is the only pin-refresh UX even though it owns many files forbidden by P4-16. The credential-separated route job also stopped filing the override ratchet issue, and the P4-18 prohibition on overrides in advisory-human mode is not wired into either decision path. These gaps jointly explain why narrow fixes kept appearing only in Notes.

### One authority stage, typed PR lanes

The managed workflow has one target-owned `authority` job that never executes candidate code. It binds `base_sha` and `head_sha` from the event, validates that fetched commits equal those values, reads the target config/workflows/pin from one canonical base commit, and reads candidate paths/artifacts from one canonical head commit as data. It emits a content-hashed authority manifest and snapshot artifact consumed by later jobs. A consumer rejects a missing, stale, mismatched, duplicated, or extra manifest field; it never reconstructs a snapshot path or accepts output from the candidate-executing job.

The deterministic classifier returns one and only one lane:

- `governed`: one or more active change bundles are touched, each candidate bundle exists, parses, has a present valid approval, and no framework-bootstrap path is changed;
- `framework-bootstrap`: no active bundle is touched, the strict framework pin changes to another valid immutable source commit, and every other changed path is an allowed managed workflow for the unchanged target posture;
- `authority-finalization`: the target is the exact shipped legacy-transition workflow and the candidate replaces only that workflow with the exact target-pinned final workflow;
- `archive`: an approved active bundle is moved intact into the canonical archive, its spec merge is present, its seal remains valid against the base-approved bytes, and no unrelated lane is mixed in.

An empty diff, a direct product/config/test/docs change, a bundle deletion without a valid archive, framework paths mixed with a governed bundle, a workflow-only edit without the exact finalization precondition, or any unclassified path is an enforcement error. Derived `state.yaml` rows retain P4-22's narrow diff-fact exclusion but do not create or select a lane.

The workflow invokes `crucible ci verify`, not the locally permissive `crucible verify`, and `crucible ci route`, not shell bundle discovery. CI verification requires the authority manifest and valid approval, verifies seals both before and after candidate execution, and handles archive regression without inventing a current bundle. The route command revalidates the same manifest from exact commits, recomputes every decision under target config, aggregates multi-change routing, and carries validated override issue payloads. An override is red when target `review.human_mode` is advisory. When human review is required, only route has review-read/issue-write permission; it files the ratchet issue idempotently before checking for a non-author approval.

### Dedicated upgrade transaction and legacy authority transition

`crucible framework upgrade --source <owner/repository@sha>` is the only supported consumer pin-refresh operation. It is distinct from `init`: it reads existing strict enforcement config to preserve adapter and review posture, computes the desired lock/main-workflow/optional-review-workflow bytes in memory, validates the resulting tracked diff against the bootstrap allowlist, then commits the file transaction or restores the original bytes on failure. It refuses a dirty tracked tree, malformed/incongruent initialized target, unsupported source checkout, declined/partial write, or an active approval that seals the current framework lock. It may refresh the ignored local launcher, but ignored bytes are neither PR evidence nor allowlisted tracked output.

GitHub's event-source rule makes the P4-22 Notes target a real migration boundary: its default branch contains only a candidate-owned `pull_request` workflow, while final authority uses base-owned `pull_request_target`. The upgrade command detects this exact legacy form and produces a bounded two-step transition rather than a false one-step promise. The first explicitly reviewed legacy PR contains the new lock plus an exact dual-trigger transition workflow whose `verify` context remains available under the old target and whose candidate-executing path has no write/secret authority. Once merged, the second workflow-only finalization PR is judged by the now-target-owned transition workflow and replaces it with the final template. Future upgrades are single isolated bootstrap PRs. Any other legacy shape stops with an attributable migration error.

### Executable release contract

The acceptance manifest is versioned test data with stable requirement IDs and exact test names. A meta-test fails if a requirement has no discovered test, a named test is absent/skipped, or a new managed-workflow consumer is missing from the matrix. The harness executes rendered workflow scripts rather than paraphrases against separate base/head remotes, GitHub-style output/artifact files, generic and Spring/JUnit consumers, and all four review postures. It covers ordinary, bootstrap, finalization, archive, fork, hostile candidate, and complete malformed/tool-failure cases. Framework CI and the local release command run the same manifest. Notes rollout is prohibited until a clean mirror starting at its current P4-22 target pin completes both transition PR simulations, the solo-posture governed change, and a newly sealed create-note verification.

### Legacy bootstrap amendment (2026-08-16)

The first PR from a `pull_request`-only target is outside P4-25 authority because the target pin cannot execute the authority command yet. The generated bridge makes that absence explicit: on `pull_request`, only `legacy-bootstrap` runs, with read-only contents permission and static acknowledgement prose. It executes no candidate command and its result is not a Crucible check. `authority`, `verify`, and `route` have an event guard that permits only target-owned `pull_request_target` or review events.

The operator acknowledges this manual root bootstrap through the upgrade command and temporarily removes `verify` from GitHub required checks. The exact bridge, configured adapter, and target review posture are byte compared for finalization. Finalization requires the same pin that installed the bridge, changes only the main managed workflow, and is then classified through the target-owned authority job. A repin, a lookalike bridge, or any phase-one claim of authority is red.
