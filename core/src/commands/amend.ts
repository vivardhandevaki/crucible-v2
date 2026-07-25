// `crucible amend` — the cheap mid-implementation spec fix and the ONE path out
// of an escalation (charter §Approval, Amend, Override; §Escalation layer 2;
// design phase-2.md §3).
//
// amend is the post-approval sibling of `propose --revise`: once a bundle is
// sealed, a direct edit voids the approval (invariant 6), so the only coherent
// way to change the spec is through the agent. amend shows the human what will
// change, has the propose-role agent regenerate the affected artifacts + bound
// tests (fresh context, invariant 10), re-judges that output (the agent is
// judged, never trusted — invariant 2), and on the human's confirmation appends
// a delta entry with fresh hashes to approval.yaml (the P1-06 `amendments`
// array) and clears any escalation. Implement then resumes: its two gates — no
// pending escalation, a valid seal — both pass again.
//
// Escalation resolution folds into this same flow (charter): when an
// escalation.yaml is present, the `resolution` is the option the human picked
// (or a custom instruction) and clearing the escalation is part of a successful
// amend. A red regeneration re-seals NOTHING and clears NOTHING — the ambiguity
// is still unresolved, and the report (exit 1 at the CLI) says why.
//
// Determinism (invariant 12): substrate, resolver, confirm, clock, identity, and
// notify are injected (`AmendDeps`); the transcript is minted from the injected
// clock (architecture.md §6). Notify is fire-and-forget (invariant 11).

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  amendApproval,
  loadApproval,
  serializeApproval,
  verifyApproval,
} from '../artifacts/approval.js';
import { loadOracles } from '../artifacts/oracles.js';
import { readEscalationIfPresent } from '../artifacts/escalation.js';
import { serializeGeneration, stampGeneration } from '../artifacts/generation.js';
import type { ResolveFn } from '../lint/traceability.js';
import type { AgentSubstrate } from '../substrate/types.js';
import type { NotifyFn } from '../notify/types.js';
import { appendStateEvent } from '../state/state.js';
import { computeHashScope, dependencyOrder, judgeBundle } from './bundle.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { readChangeType } from '../changetype/changetype.js';
import { renderReport, type VerifyReport } from '../verifyx/report.js';
import { preconditionError } from '../util/errors.js';

/** Injected non-deterministic edges — so amend's core stays reproducible. */
export interface AmendDeps {
  /** The agent session runner (architecture.md §6). Runs the propose role. */
  substrate: AgentSubstrate;
  /** Batch dry-run resolver (charter §Bindings) — powers the re-judgment lint
   * and supplies each bound target's file for the fresh hash scope. */
  resolve: ResolveFn;
  /** Confirm the regenerated diff before re-sealing. Skipped under `--yes`. */
  confirm: () => Promise<boolean>;
  /** The amendment timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /** Who is amending (e.g. git user email). Injected for determinism. */
  amendedBy: () => string;
  /** Convenience notify dispatcher (invariant 11) — fire-and-forget, may throw. */
  notify: NotifyFn;
}

/** amend invocation options. `root` is the repo root the seal is relative to. */
export interface AmendOptions {
  /** Repo root: the hash scope is expressed relative to this (design §4). */
  root: string;
  /** The change to amend (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /**
   * The resolution/instruction handed to the regeneration: for an escalation,
   * the option the human picked (or a custom fix); for a general mid-flight
   * fix, the spec-change instruction. Required, non-empty (else exit 2).
   */
  resolution: string;
  /** Model id for the session (convenience `models.propose`; opaque here). */
  model: string;
  /** Skip the confirmation prompt (`--yes`). */
  yes: boolean;
}

/** amend outcome: `amended` is false when the regeneration was red or declined. */
export interface AmendResult {
  /** True only when the re-seal was written (green regeneration + confirmed). */
  amended: boolean;
  /** The post-regeneration judgment (bundle + traceability). */
  report: VerifyReport;
  /** The rendered amend surface (escalation options / changed-artifact diff). */
  render: string;
  /** Relative paths re-sealed (present only when `amended`). */
  sealedFiles?: string[];
  /** Absolute path of the captured regeneration transcript. */
  transcriptPath: string;
}

/**
 * Run amend: gate on a valid approval → (record any escalation being resolved) →
 * regenerate via the propose role → re-judge → confirm → append an amendment
 * with fresh hashes + clear the escalation. Throws `CrucibleError` on a
 * precondition failure (exit 2: no change / no approval / empty resolution;
 * missing role prompt) or fail-closed defect (exit 3: malformed escalation or
 * approval). A RED regeneration is returned in the report (exit 1 at the CLI),
 * never thrown — and it re-seals nothing and clears nothing.
 */
export async function amend(options: AmendOptions, deps: AmendDeps): Promise<AmendResult> {
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

  const resolution = options.resolution.trim();
  if (resolution.length === 0) {
    throw preconditionError(
      'NO_RESOLUTION',
      'An amend must state the resolution — which escalation option to take, or the spec fix to apply.',
      `Run \`crucible amend ${change} "<the option or fix>"\`.`,
    );
  }

  // Precondition (invariant 5): a valid approval. amend is the POST-approval
  // path — a not-yet-approved bundle is edited with `crucible propose --revise`.
  // Missing approval.yaml → exit 2 (loadApproval); malformed → exit 3.
  const approvalPath = join(changeDir, 'approval.yaml');
  const approval = loadApproval(approvalPath);

  // The role prompt is a per-project TCB file (architecture §Static Context
  // Surfaces). Checking here turns the substrate's own refusal into a teaching
  // precondition — amend regenerates through the propose role.
  const rolePromptPath = join(root, '.crucible', 'context', 'propose.md');
  if (!existsSync(rolePromptPath)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The propose role prompt is missing at ${join('.crucible', 'context', 'propose.md')}.`,
      'Restore .crucible/context/propose.md (installed by `crucible init` from P2; until then check it into the repo).',
    );
  }

  // An escalation being resolved (if any). A malformed escalation.yaml fails
  // closed at exit 3 here (invariant 3) — we cannot resolve what we cannot read.
  const escalationPath = join(changeDir, 'escalation.yaml');
  const escalation = readEscalationIfPresent(escalationPath);

  // Fresh-context regeneration session (invariant 10). Transcript minted from
  // the injected clock (architecture.md §6: caller-owned naming).
  const transcriptPath = join(
    root,
    '.crucible',
    'transcripts',
    change,
    `amend-${deps.now().replace(/[:.]/g, '-')}.jsonl`,
  );
  await deps.substrate.run({
    role: 'propose',
    rolePromptPath,
    taskPayload: buildAmendPayload(change, changeRel, resolution, escalation?.question),
    cwd: root,
    model,
    transcriptPath,
  });
  // SubstrateResult carries nothing to trust (invariant 2) — judge the files.

  const report = await judgeBundle(
    change,
    changeDir,
    changeRel,
    deps.resolve,
    collectArchivedRequirementIds(root),
    readChangeType(changeDir),
  );

  // A red regeneration cannot be re-sealed and does not resolve the ambiguity:
  // return the report (exit 1 at the CLI), leaving the escalation in place so
  // implement stays halted. Record the attempt (audit only, invariant 1).
  if (report.verdict !== 'pass') {
    appendStateEvent(
      join(changeDir, 'state.yaml'),
      change,
      {
        at: deps.now(),
        cmd: 'amend',
        summary: `regeneration judged ${report.verdict} — not re-sealed`,
      },
      'amend-red',
    );
    return {
      amended: false,
      report,
      render: renderReport(report, 'amend'),
      transcriptPath,
    };
  }

  // The regenerated bundle is green. Compute the fresh seal scope and show the
  // human exactly which sealed artifacts changed (the "diff" surface, charter:
  // "shows the diff between approved state and current artifacts").
  const oracles = loadOracles(join(changeDir, 'oracles.md'));
  const relpaths = await computeHashScope(root, changeRel, changeDir, oracles, deps.resolve);
  const changed = changedSince(root, approval.files, relpaths);
  const render = renderAmend(change, escalation, resolution, changed);

  // Confirm the regenerated diff unless --yes. Declining writes nothing: the
  // seal stands as it was and the escalation (if any) is left unresolved.
  if (!options.yes) {
    const confirmed = await deps.confirm();
    if (!confirmed) {
      return { amended: false, report, render, transcriptPath };
    }
  }

  // Re-seal: append a delta entry with fresh hashes to approval.yaml (charter
  // wire format). `amendApproval` recomputes every covered file's hash from
  // current bytes and updates the live `files` seal, so verifyApproval passes.
  const amended = amendApproval(root, relpaths, deps.now(), approval);
  writeFileSync(approvalPath, serializeApproval(amended), 'utf8');

  // Re-stamp the generation ledger: the regenerated bundle is coherent, so
  // staleness starts clean from here (keeps a later `--revise`/approve honest).
  const generation = stampGeneration(changeDir, change, dependencyOrder(changeDir), deps.now());
  writeFileSync(join(changeDir, 'generation.yaml'), serializeGeneration(generation), 'utf8');

  // Clear the escalation (charter §Escalation layer 2: resolution flows through
  // amend). Its removal is what lets implement resume — the structural blocker
  // is the artifact's presence (commands/implement.ts).
  if (escalation !== undefined) {
    rmSync(escalationPath, { force: true });
  }

  // Audit trail, written last, never read to gate (invariant 1). Records WHO
  // amended for parity with approve's approved_by / escalate's filed_by.
  const who = deps.amendedBy();
  const summary = escalation
    ? `escalation resolved by ${who} (${resolution}); re-sealed ${relpaths.length} file(s)`
    : `spec amended by ${who} (${resolution}); re-sealed ${relpaths.length} file(s)`;
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    { at: deps.now(), cmd: 'amend', summary },
    'amended',
  );

  // Announce (charter §Notify Hooks). Fire-and-forget (invariant 11): a broken
  // hook never changes the outcome — the re-seal is already on disk.
  try {
    await deps.notify({ kind: 'escalation', change, summary: `AMENDED: ${summary}` });
  } catch {
    /* convenience-never-enforcement: a broken hook cannot fail an amend. */
  }

  return { amended: true, report, render, sealedFiles: relpaths, transcriptPath };
}

/**
 * The regeneration work order (charter §Editing Artifacts / §Escalation): apply
 * the resolution and regenerate every dependent artifact + bound test so the
 * bundle stays coherent. When resolving an escalation, the ambiguous question is
 * surfaced so the agent knows exactly what the resolution answers.
 */
function buildAmendPayload(
  change: string,
  changeRel: string,
  resolution: string,
  escalationQuestion: string | undefined,
): string {
  const lines = [`Change: ${change}`, `Bundle directory: ${changeRel}/`];
  if (escalationQuestion !== undefined) {
    lines.push('An escalation is open. The human has resolved this ambiguity:');
    lines.push(`  Question: ${escalationQuestion}`);
  }
  lines.push('Apply this resolution to the APPROVED bundle, then regenerate every dependent');
  lines.push('artifact (design → spec delta → oracles → bound tests) so the bundle stays');
  lines.push('internally consistent — a stale downstream artifact is a bug.');
  lines.push('Resolution:');
  lines.push(resolution);
  return lines.join('\n');
}

/**
 * The sealed relpaths whose current bytes differ from the prior seal — the set
 * of artifacts this amend changed. A relpath absent from the prior seal (a
 * newly-bound test file) counts as changed. Sorted for a stable render.
 */
function changedSince(
  root: string,
  priorFiles: Record<string, string>,
  relpaths: readonly string[],
): string[] {
  const verdict = verifyApproval(root, {
    version: 0,
    change: '',
    approved_by: '',
    approved_at: '',
    files: Object.fromEntries(relpaths.map((rel) => [rel, priorFiles[rel] ?? ''])),
    amendments: [],
  });
  // verifyApproval lists every relpath whose current hash != the supplied one —
  // exactly the changed set (a missing prior hash '' never matches, so a newly
  // added file is reported changed).
  return verdict.valid ? [] : verdict.mismatches;
}

/** The amend surface: the escalation (if any), the resolution, the changed set. */
function renderAmend(
  change: string,
  escalation: ReturnType<typeof readEscalationIfPresent>,
  resolution: string,
  changed: readonly string[],
): string {
  const lines: string[] = [`Amend change: ${change}`, ''];
  if (escalation !== undefined) {
    lines.push('Resolving escalation:');
    lines.push(`  ${escalation.question}`);
    lines.push('  Options offered:');
    for (const option of escalation.options) lines.push(`    - ${option}`);
    lines.push('');
  }
  lines.push(`Resolution: ${resolution}`);
  lines.push('');
  lines.push(`Artifacts changed by regeneration (${changed.length}):`);
  if (changed.length === 0) {
    lines.push('  (none — the regeneration produced byte-identical artifacts)');
  } else {
    for (const rel of changed) lines.push(`  ~ ${rel}`);
  }
  lines.push('');
  return lines.join('\n');
}
