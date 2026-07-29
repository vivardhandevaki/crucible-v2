// `crucible implement` — the command on the *other side* of the human gate
// (charter §Tasks live on the other side of the gate; design phase-0-1.md §6).
//
// implement is the first command that runs against an APPROVED bundle. Its two
// load-bearing guarantees are both structural, not trust-based:
//
//   1. It refuses to run without a *valid* approval (invariant 5): missing
//      approval.yaml → exit 2 naming `crucible approve`; a void seal (a sealed
//      file edited or gone since approval) → exit 2 listing every mismatch. A
//      change may not be implemented until a human has sealed its bundle.
//   2. It generates `tasks.md` as its first action (charter): before any
//      implementation session runs, one substrate session (role=implement)
//      authors the work breakdown, and the command then VERIFIES tasks.md exists
//      on disk (invariant 2 — the agent's claim is worth zero; only the artifact
//      counts). Implementation cannot begin without a plan the command can see.
//
// It also honors the escalation layer (charter §Escalation, layer 2, added P2-04):
// while an unresolved escalation.yaml exists in the bundle it refuses to resume
// (exit 2, teach `crucible amend`), and if THIS run's implement session files one
// it halts before verify — the agent stopped on an ambiguity only a human may
// resolve, and there is nothing to judge until they do.
//
// After the (single, non-looping — P1 has no iteration budget, that is P2)
// implement session, it runs the local `verify` core (P1-12) and returns that
// report: a red verdict is the code failing, mapped to exit 1 at the CLI, never
// thrown. The implement session that touches a sealed test file is caught here,
// by verify's approval-hash check going red — the seal doing its job.
//
// Determinism (invariant 12): substrate, resolver, oracle runner, and clock are
// injected (`ImplementDeps`); transcripts are minted by the command from the
// injected clock (architecture.md §6). Each session is fresh-context (invariant
// 10): role prompt from `.crucible/context/implement.md` + a work-order payload.

import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { readEscalationIfPresent } from '../artifacts/escalation.js';
import type { CrucibleError } from '../util/errors.js';
import type { ResolveFn } from '../lint/traceability.js';
import type { AgentSubstrate } from '../substrate/types.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import { verify } from './verify.js';
import { renderReport, type VerifyReport } from '../verifyx/report.js';
import { LOCAL_VERIFY_SUMMARY_PREFIX, appendStateEvent } from '../state/state.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

/** Injected non-deterministic edges — so implement's core stays reproducible. */
export interface ImplementDeps {
  /** The agent session runner (architecture.md §6). The CLI wires ClaudeCode. */
  substrate: AgentSubstrate;
  /**
   * Batch dry-run resolver (charter §Bindings & the Adapter Protocol) — handed
   * to the local `verify` for the traceability lint. Injected because the real
   * one spawns the adapter (P1-11 client); tests pass a pure function.
   */
  resolve: ResolveFn;
  /**
   * Execute every oracle's bound targets and join results back to oracle ids
   * (the adapter client's `run`) — handed to the local `verify`. skip→fail is
   * coerced in the client, not here.
   */
  run: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
  /** ISO 8601 clock — transcript naming + state events. No wall-clock in core. */
  now: () => string;
}

/** implement invocation options. `root` is the target repo root. */
export interface ImplementOptions {
  /** Repo root the sessions run in; approval hashes are relative to it. */
  root: string;
  /** The change to implement (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** Model id for the sessions (convenience `models.implement`; opaque here). */
  model: string;
}

/** implement outcome: the local verify report + where each session's transcript went. */
export interface ImplementResult {
  /** The local verify verdict after implementation (checks + verdict). */
  report: VerifyReport;
  /** Terminal rendering of the report (the CLI prints it). */
  render: string;
  /** Absolute transcript paths for the two sessions (tasks then implement). */
  transcriptPaths: { tasks: string; implement: string };
}

/**
 * Run implement: gate on a valid approval → generate tasks.md (first action,
 * structurally verified) → run the implement session → local verify. Throws
 * `CrucibleError` on a precondition failure (exit 2: no/void approval, missing
 * role prompt) or fail-closed defect (exit 3: the tasks session produced no
 * tasks.md; malformed artifact bubbling from verify). A red verify *verdict* is
 * returned in the report, never thrown — the CLI maps it to exit 1.
 */
export async function implement(
  options: ImplementOptions,
  deps: ImplementDeps,
): Promise<ImplementResult> {
  const { root, change, model } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // Precondition (invariant 5 / charter): a valid approval. Missing approval.yaml
  // → exit 2 naming `crucible approve`; malformed → exit 3 (fail-closed parser).
  const approval = loadApproval(join(changeDir, 'approval.yaml'));

  // A void seal — a sealed file edited or gone since approval — refuses here
  // (invariant 6): implement may not run against a bundle whose approved bytes
  // no longer hold. Exit 2, naming every mismatch and the re-seal command.
  const verified = verifyApproval(root, approval);
  if (!verified.valid) {
    const detail = verified.mismatches.map((rel) => `  ✗ ${rel}`).join('\n');
    throw preconditionError(
      'APPROVAL_VOID',
      `Cannot implement ${change}: the approval is void — these sealed files changed or went missing since approval:\n${detail}`,
      `Re-review and re-run \`crucible approve ${change}\` to re-seal, then \`crucible implement ${change}\`.`,
    );
  }

  // The role prompt is a per-project TCB file (architecture §Static Context
  // Surfaces). The substrate would also refuse without it (exit 3); checking
  // here first turns that into a teaching precondition.
  const rolePromptPath = join(root, '.crucible', 'context', 'implement.md');
  if (!existsSync(rolePromptPath)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The implement role prompt is missing at ${join('.crucible', 'context', 'implement.md')}.`,
      'Restore .crucible/context/implement.md (installed by `crucible init` from P2; until then check it into the repo).',
    );
  }

  // Structural escalation gate (charter §Escalation, layer 2): while an unresolved
  // escalation.yaml exists, implement refuses to resume — the agent stopped on an
  // ambiguity that only a human (via `crucible amend`) may resolve. A malformed
  // escalation fails closed at exit 3 inside the reader (invariant 3); a valid one
  // → exit 2 naming `crucible amend`. escalation.yaml is a real artifact, so
  // gating on it is enforcement-from-truth, not from the derived state cache.
  const escalationPath = join(changeDir, 'escalation.yaml');
  if (readEscalationIfPresent(escalationPath) !== undefined) {
    throw escalationPendingError(change);
  }

  // Both sessions mint transcripts from the injected clock (architecture.md §6:
  // caller-owned naming). Distinct prefixes so the two never collide on one tick.
  const stamp = deps.now().replace(/[:.]/g, '-');
  const tasksTranscript = join(
    root,
    '.crucible',
    'transcripts',
    change,
    `implement-tasks-${stamp}.jsonl`,
  );
  const implementTranscript = join(
    root,
    '.crucible',
    'transcripts',
    change,
    `implement-${stamp}.jsonl`,
  );

  // First action (charter): generate tasks.md. Fresh-context session (invariant 10).
  await deps.substrate.run({
    role: 'implement',
    rolePromptPath,
    taskPayload: buildTasksPayload(change, changeRel),
    cwd: root,
    model,
    transcriptPath: tasksTranscript,
  });

  // Structural gate (invariant 2): the session's exit code is worth zero — the
  // work breakdown exists only if the file does. No tasks.md → nothing to
  // implement against; fail closed rather than run a blind implement session.
  const tasksPath = join(changeDir, 'tasks.md');
  if (!existsSync(tasksPath) || statSync(tasksPath).size === 0) {
    throw invalidInputError(
      'TASKS_NOT_GENERATED',
      `The implement role did not author ${join(changeRel, 'tasks.md')} — there is no work breakdown to implement against.`,
      `Inspect the transcript at ${tasksTranscript} and re-run \`crucible implement ${change}\`.`,
    );
  }
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    {
      at: deps.now(),
      cmd: 'implement',
      summary: 'tasks.md generated',
      transcript: relative(root, tasksTranscript),
    },
    'implementing',
  );

  // The implement session — single, non-looping in P1 (iteration budget is P2).
  // Fresh context again (invariant 10): it reads tasks.md + the bundle from disk.
  await deps.substrate.run({
    role: 'implement',
    rolePromptPath,
    taskPayload: buildImplementPayload(change, changeRel),
    cwd: root,
    model,
    transcriptPath: implementTranscript,
  });
  // SubstrateResult carries nothing to trust (invariant 2) — judge via verify.

  // Mid-run halt (charter §Escalation, layer 2 — "escalate ... ends the run"): if
  // the implement session hit an ambiguity and ran `crucible escalate`, the bundle
  // now carries an escalation.yaml. Stop BEFORE verify — there is nothing to judge
  // yet, and claiming a verdict over a half-done change would be dishonest. Record
  // the halt (audit only, invariant 1) and refuse with the same `amend` hint the
  // resume gate uses; a malformed escalation still fails closed at exit 3 here.
  if (readEscalationIfPresent(escalationPath) !== undefined) {
    appendStateEvent(
      join(changeDir, 'state.yaml'),
      change,
      {
        at: deps.now(),
        cmd: 'implement',
        summary: 'halted — escalation filed',
        transcript: relative(root, implementTranscript),
      },
      'escalated',
    );
    throw escalationPendingError(change);
  }

  // Local verify (design §6): reuse the P1-12 core. A void seal (the session
  // edited a sealed test file) surfaces as a red `approval` check, exit 1 — the
  // seal catching an immutability violation rather than trusting the session.
  const report = await verify({ root, change }, { resolve: deps.resolve, run: deps.run });

  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    {
      at: deps.now(),
      cmd: 'implement',
      summary: `${LOCAL_VERIFY_SUMMARY_PREFIX} ${report.verdict}`,
      transcript: relative(root, implementTranscript),
    },
    report.verdict === 'pass' ? 'implemented' : 'implement-red',
  );

  return {
    report,
    render: renderReport(report, 'implement'),
    transcriptPaths: { tasks: tasksTranscript, implement: implementTranscript },
  };
}

/**
 * The exit-2, teach-`amend` error both escalation gates raise (charter §Escalation
 * layer 2): the resume-refusal (a pending escalation from a prior run) and the
 * mid-run halt (this run's session filed one). Identical outcome — the loop stops
 * until a human resolves the ambiguity through `crucible amend`, never improvised.
 */
function escalationPendingError(change: string): CrucibleError {
  return preconditionError(
    'ESCALATION_PENDING',
    `Cannot implement ${change}: an unresolved escalation is pending (escalation.yaml). ` +
      'The implement agent stopped on a decision that is not derivable from the approved spec.',
    `Resolve it with \`crucible amend ${change}\` (pick an option / patch the spec), ` +
      `then re-run \`crucible implement ${change}\`.`,
  );
}

/** The work order for the first session: author the work breakdown, nothing else. */
function buildTasksPayload(change: string, changeRel: string): string {
  return [
    `Change: ${change}`,
    `Bundle directory: ${changeRel}/`,
    'First action: author the work breakdown for this approved change.',
    `Read the approved bundle and write ${join(changeRel, 'tasks.md')} as a checklist of the`,
    'implementation steps that will make every bound oracle test pass. Do NOT implement',
    'anything yet, and do NOT modify any sealed artifact or bound test file.',
  ].join('\n');
}

/** The work order for the implement session: make the sealed oracle tests pass. */
function buildImplementPayload(change: string, changeRel: string): string {
  return [
    `Change: ${change}`,
    `Bundle directory: ${changeRel}/`,
    `Implement the approved change per ${join(changeRel, 'tasks.md')} and the bundle: write the`,
    'implementation so every bound oracle test passes. Do NOT modify any sealed file (the spec',
    'deltas, oracles.md, design.md, proposal.md, or any bound test file) — the approval hash',
    'seals them and any edit voids the approval.',
  ].join('\n');
}
