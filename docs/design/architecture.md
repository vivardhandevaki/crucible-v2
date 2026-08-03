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

## 7. Adapter wire contract (frozen by charter; settled P1-11)

Verbs `resolve`/`run` (+ optional `scope`), JSON over stdin/stdout, normalized result schema per charter §"Oracle File Syntax & Adapter Binding Spec". The TypeScript types in `core/src/adapters/types.ts` are the canonical machine form.

**Settled shape (P1-11):**
- **Request** (both verbs): `{ "targets": string[] }` written to the adapter's stdin.
- **Response** (both verbs): `{ "results": [...] }` on stdout, one entry per requested target. Two envelopes, zod-validated separately so a resolve-only status can't masquerade as a run status: `resolve → { target, status: "found"|"missing", targetFile? }`; `run → { target, status: "pass"|"fail"|"error"|"skip", message?, location?, duration_ms? }` (charter normalized schema exactly). Unknown fields → exit 3 (strict).
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
| review | Forbidden until a separate ratification | Required fresh `AgentSubstrate` role |
| amend + approve-time regeneration | Not in P4-10 | Existing fresh propose role |
| approve / verify / escalate / override / archive / status / why | Thin pinned-CLI skills only | Deterministic or existing behavior |

### Public CLI and handoff contract

The session surface is:

```
crucible session status <change>
crucible session propose start <change> <intent> [--type feature|bugfix|refactor]
crucible session propose next|resume|finish <change>
crucible session propose revise <change> <instruction>
crucible session implement start|tasks-ready|resume|finish <change>
```

Every successful stage emits strict JSON `SessionHandoffV1`: `{ version: 1, change, role, operation, stage, change_dir, role_prompt, instructions[], next_command, input_hash }`. Unknown or missing fields fail exit 3. `session status` emits artifact-derived phase plus an allow-list of exact next commands; the hub skill may display only that list. Human-readable output may render the same object, but skills use `--json`.

Gitignored `.crucible/sessions/<change>/<role>.json` checkpoints persist only explicit CLI inputs and the current stage. `input_hash` seals the relevant inputs (propose operation/type/intent; implement approval bytes). They make interruption recovery deterministic but are **not enforcement artifacts**: approval, hash scope, tier, verify, review, routing, archive, and CI have no dependency on `session/`. Missing checkpoints teach the exact restart command; malformed checkpoints exit 3; stale input hashes exit 2 and name the required restart/amend action. Deleting or forging one can at worst disrupt local guidance—it cannot produce a valid bundle, approval, verdict, or merge.

### Propose lifecycle

1. `start` validates name, intent, type, role prompt, and absence of an existing change; records the deterministic create handoff; then scaffolds through Crucible's packaged, pinned OpenSpec runtime with the type-specific schema. A failed scaffold is resumable from the recorded input and is never treated as success.
2. `next` revalidates the checkpoint and asks the packaged OpenSpec runtime for status plus the next ready artifact instructions. The active session reads dependencies and writes only the returned paths. `resume` performs the same derivation after interruption. Neither command trusts conversation history or OpenSpec's completion claim.
3. `revise` requires an existing unapproved change, records the explicit revision instruction, and returns the full dependency-ordered regeneration handoff. Approved changes still require `amend`.
4. `finish` runs Crucible bundle parsing, type conformance, adapter binding resolution, and traceability lint. Red is exit 1 with the checkpoint retained for fixes/retry; malformed trusted inputs are exit 3. Green alone stamps `generation.yaml`, appends `execution_mode: session-native` audit provenance, and exposes `approve` as next.

The Crucible propose skill is therefore **not** a wrapper around OpenSpec's `openspec-propose` skill: that upstream workflow creates `tasks.md` before approval and does not enforce Crucible oracles or seals. Only the pinned Crucible CLI may call OpenSpec's scaffold/status/instructions primitives.

### Implement lifecycle

1. `start` requires an existing change, parseable and valid approval seal, role prompt, and no unresolved escalation. It records the approval-file hash and emits only the tasks-stage handoff, even when an old `tasks.md` exists.
2. `tasks-ready` revalidates the same approval hash and requires a non-empty `tasks.md` before moving the checkpoint to implementation. `resume` revalidates artifacts and returns only the current stage's handoff.
3. `finish` requires the implementation-stage checkpoint, independently revalidates approval/tasks/escalation, and runs ordinary local `verify`. A pending escalation exits 2 naming `amend`; red verify exits 1 and remains resumable; green records session-native provenance. Any sealed-file edit is caught by the unchanged approval check.

### Skills, launcher, permissions, and audit

`init` owns one hub plus command-specific `SKILL.md` assets for `crucible`, propose, approve, implement, verify, review, amend, escalate, override, archive, status, and why. It installs the portable `name`/`description` subset under both `.agents/skills/<name>/` (Codex) and `.claude/skills/<name>/` (Claude Code), validates metadata before writing, and uses the existing idempotent diff-and-confirm policy so human bytes outside managed regions are preserved.

Every installed skill calls `node .crucible/bin/crucible.mjs`; none calls an ambient `crucible`. `init` generates that gitignored local launcher from the source checkout used for initialization. Each call strictly loads `.crucible/framework.lock.json`, verifies the checkout's normalized GitHub repository and `HEAD` against the pin, verifies the built CLI exists, then delegates without fallback. A missing launcher/check-out/build is exit 2 with the exact `init` recovery; a malformed or mismatched pin is exit 3. This is advisory local provenance on an untrusted developer machine; CI continues to check out and build the target branch's exact pin independently.

Interactive filesystem/shell permissions are selected and enforced by the host Codex/Claude surface. No Crucible enforcement or convenience setting broadens them, and a permission denial is an interrupted local stage—not a reason to fall back to P4-09's `danger-full-access`. Session checkpoints and `state.yaml` are audit/convenience only. Session-native state events set `execution_mode: session-native` and omit a Crucible transcript path; headless events set `headless` and retain their caller-minted transcript. Neither field is an enforcement input.
