# architecture.md — Cross-Phase Stable Contracts

**Status: seed.** This file holds only contracts shared across phases. Phase design docs reference it and never duplicate it. It starts small and grows as Phase 1 settles interfaces. The amendment discipline applies here most strictly: changing this file is changing the law of the codebase — same commit as the code, rationale required. Sections marked `[SETTLES: P1]` are filled/frozen by the named phase.

## 1. Module map & layering (core/)

```
cli/          command entry points; parses args, prints, exits. No logic.
commands/     one module per command; orchestrates lower layers.
artifacts/    read/parse/validate OpenSpec + Crucible artifacts (bundle, oracles, spec deltas, approval, state, escalation)
hash/         canonical sha256 file/bundle hashing; approval sealing & verification
lint/         traceability: extraction + set arithmetic
tier/         legacy P2/P3 policy; parked during Phase 4R
verifyx/      verify orchestration; aggregates check results into a report
skills/       provider-neutral workflow definitions + generated agent-tool wrappers
substrate/    legacy P1-P3 agent launchers; retired and removed by P4R-02
adapters/     adapter client: manifest loading, spawn, JSON transport, result normalization
config/       crucible.yaml / settings.yaml / local.yaml loading + validation
state/        legacy committed state; replaced by artifact-derived status in P4R
notify/       convenience-only dispatch (terminal/desktop/webhook/github); may fail, never blocks (added P2-00, built P2-15)
util/         pure helpers only
```

**Dependency direction (enforced by convention, later by lint):** `cli → commands → {artifacts, hash, lint, verifyx, skills, adapters, config, state, notify} → util`. Lower layers never import upward. Nothing in the CLI or command graph invokes an agent; generated skills are data consumed by an already-active agent tool. Nothing outside `adapters` spawns an adapter process. Legacy `tier/` and `substrate/` remain only until their Phase 4R removal/parking tasks land.

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

## 6. Agent execution boundary (amended P4R-00)

The P1-P3 `AgentSubstrate` contract below is historical and remains useful for
understanding the removed headless path. Phase 4 validation proved that CLI-
spawned agents create sandbox, context, recovery, and trust-boundary complexity
that is unnecessary for the ordinary product. P4R-02 retires the interface from
production command paths and removes it after replacement coverage is red.

The active contract is:

- `init` installs provider-appropriate skills/commands from one canonical
  workflow definition;
- skills run inside the user's already-active agent session and call only the
  project-local pinned CLI;
- CLI commands scaffold, instruct, validate, seal, verify, and archive but never
  invoke `codex`, `claude`, or another agent;
- no conversation message, skill result, or persisted session checkpoint is an
  enforcement input;
- `status` derives allowed next actions from artifacts and strict preconditions.

### Historical P1-P3 shape

Contract intent, unchanged since seed:
- Input: role (propose|implement|review), prompt/context payload, working dir, model id.
- Output: exit status, path to the session transcript (trajectory artifact), and nothing else — substrate output is never parsed for "did it succeed"; success is judged from artifacts it produced.

**Frozen shape (P1-08):** canonical machine form in `core/src/substrate/types.ts`.

- **Request:** `{ role, rolePromptPath, taskPayload, cwd, model, transcriptPath, timeoutMs? }`. The **caller mints `transcriptPath`** (convention `.crucible/transcripts/<change>/<role>-<ts>.jsonl`, owned by `commands/`): the substrate never invents paths, knows nothing of "changes", and holds no wall-clock naming — the audit-trail timestamp stays in the layer that already owns audit concerns. *(Amends the phase-0-1 §5 draft, which had the substrate computing this path.)*
- **Result:** `{ exitCode, transcriptPath }` — exactly two fields. Invariant 2 is enforced structurally: no success flag, no message, nothing parsed, nothing to trust. On every returned result the transcript file exists (possibly truncated if the run died mid-stream).
- **Returned vs thrown:** every outcome of a *started* run is **returned**, never thrown - non-zero exit, agent-side crash, or timeout (transcript preserved). `SUBSTRATE_UNAVAILABLE` exit 3 is reserved for inability to start: an unreadable role prompt or the selected `codex`/`claude` binary being unavailable. A dead author simply produced no trustworthy artifacts; downstream validation still fails closed.
- **Implementations (P3-10):** `CodexSubstrate` runs isolated `codex exec --json --ephemeral` sessions in `workspace-write`; `ClaudeCodeSubstrate` runs headless `claude -p`. Provider-specific flags remain inside `substrate/`; shared process/timeout/transcript behavior lives in `process.ts`; `runtime.ts` is the sole command-layer provider and model resolver. `FakeSubstrate` remains the deterministic test double. Only `AgentSubstrate` and the request/result types are frozen.
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

## 10. Phase 4R reset contracts

- Deterministic `verify` is required and credential-free. `ai-review` is a
  separate `off|advisory|required` facility.
- Adapter `resolve` returns only strict `found` with a grounded `targetFile`, or
  `missing`; core never asks an adapter where an agent may create a test.
- Approval scope is derived from the resolved OpenSpec schema and grounded
  bound tests, not a hard-coded artifact filename list.
- Archive validates and atomically moves the entire change directory before the
  feature PR, preserving every Crucible/custom artifact while leaving bound
  tests in the permanent regression suite.
- CI reads enforcement config, framework/adapter pins, and historical trust
  inputs from the exact target commit. The candidate cannot choose its own
  judge. The preferred GitHub transport is a ruleset-required trusted workflow;
  `pull_request_target` candidate execution is not the default.
- Tier-dependent ceremony, routing, override, trajectory, mutation, and ratchet
  automation are parked until the thin reset lifecycle is qualified.
