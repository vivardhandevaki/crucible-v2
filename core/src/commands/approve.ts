// `crucible approve` — the one human gate (charter §The Core Inversion, §The
// Workflow, §Approval, Amend, Override; design phase-0-1.md §6).
//
// approve is where a human seals a reviewed bundle. It is a precondition-gated
// command (invariant 5): it refuses to run — exit 2, naming the exact next
// command — unless the bundle's artifacts exist, parse, and pass the
// traceability lint. Only then does it render the review surface, ask for
// confirmation, and (on yes) write approval.yaml, sealing every bundle artifact
// + bound test file by sha256 (invariant 6, via hash/ + artifacts/approval). It
// finally appends a state event (design §3) — a derived audit trail, never read
// for an enforcement decision (invariant 1).
//
// Determinism (invariant 12): the confirm prompt, the clock, the approver
// identity, and the binding resolver are all injected (`ApproveDeps`). The core
// touches no wall-clock, no randomness, and never spawns a real adapter process
// — the CLI layer (program.ts) wires the real prompt/clock/resolver in. P1 is
// the plain terminal render; the rich side-by-side gate is P2 (phase-0-1.md §17
// deferrals).

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadProposal } from '../artifacts/proposal.js';
import type { SpecRequirement } from '../artifacts/spec-delta.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import {
  checkStaleness,
  readGenerationIfPresent,
  serializeGeneration,
  stampGeneration,
} from '../artifacts/generation.js';
import { computeHashScope, dependencyOrder, loadAllRequirements } from './bundle.js';
import { appendStateEvent } from '../state/state.js';
import { preconditionError } from '../util/errors.js';

/** The P1 approval.yaml schema version (design §3). */
const APPROVAL_VERSION = 1;

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface ApproveDeps {
  /**
   * Batch dry-run resolver (charter §Bindings & the Adapter Protocol). Powers
   * the traceability lint AND supplies each bound target's file for the hash
   * scope (`targetFile`). Injected because the real one spawns the adapter
   * process (P1-11 client); tests pass a pure function.
   */
  resolve: ResolveFn;
  /** Ask the human to confirm the seal. Skipped entirely when `--yes`. */
  confirm: () => Promise<boolean>;
  /** The approval timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /** Who is approving (e.g. git user email). Injected for determinism. */
  approvedBy: () => string;
}

/** approve invocation options. `root` is the repo root the seal is relative to. */
export interface ApproveOptions {
  /** Repo root: the hash scope is expressed relative to this (design §4). */
  root: string;
  /** The change name (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** Skip the interactive confirm (`--yes`). */
  yes: boolean;
  /**
   * `--confirm-consistency`: proceed past a staleness refusal (charter §Editing
   * Artifacts). When an upstream artifact was hand-edited after a downstream one
   * was generated, approve refuses by default; this flag asserts the human has
   * checked the edits are coherent, re-stamping the generation ledger to the
   * current bytes and sealing. The alternative is `crucible propose --revise`.
   */
  confirmConsistency?: boolean;
}

/** approve outcome: `approved` is false only when the human declined. */
export interface ApproveResult {
  approved: boolean;
  /** The rendered review surface (returned so the CLI can print it). */
  render: string;
  /** Relative paths sealed (present only when `approved`). */
  sealedFiles?: string[];
}

/**
 * Run the approve gate. Throws `CrucibleError` (exit 2) if a precondition is
 * unmet — missing artifact or a red lint — naming what to run instead; exit 3
 * bubbles up from the parsers on a malformed artifact (fail-closed input). On a
 * clean bundle it renders the review surface, confirms (unless `yes`), and on
 * confirmation writes approval.yaml + a state event. Declined → no writes.
 */
export async function approve(options: ApproveOptions, deps: ApproveDeps): Promise<ApproveResult> {
  const { root, change, yes } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // Parse the bundle. Missing artifact → exit 2 (loaders); malformed → exit 3.
  // The proposal's parse result is unused beyond validation: approve gates on
  // the whole bundle parsing (invariant 5), and the Unspecified/Seams sections
  // are part of the review surface being sealed (P1-09 proposal grammar).
  loadProposal(join(changeDir, 'proposal.md'));
  const requirements = loadAllRequirements(changeDir, changeRel);
  const oracles = loadOracles(join(changeDir, 'oracles.md'));

  // Precondition: the traceability lint must be green (invariant 5). A red lint
  // is a bundle that promises something no executable check covers — refuse to
  // seal it, and name the fix. The archived-REQ index lets a bugfix/ratchet oracle
  // legally bind an OLD requirement id from the archived spec (design phase-2.md §1).
  const archivedReqIds = collectArchivedRequirementIds(root);
  const lint = await lintTraceability(requirements, oracles, deps.resolve, archivedReqIds);
  if (!lint.ok) {
    const detail = lint.findings.map((f) => `  ✗ ${f.message}`).join('\n');
    throw preconditionError(
      'LINT_RED',
      `Cannot approve ${change}: traceability lint failed —\n${detail}`,
      `Fix the bundle and re-run \`crucible propose ${change} --revise "<fix>"\`, then \`crucible approve ${change}\`.`,
    );
  }

  // Staleness gate (charter §Editing Artifacts / invariant 5): if a generation
  // ledger exists and an UPSTREAM artifact was hand-edited after a DOWNSTREAM one
  // was generated, the downstream may be stale — refuse until the human either
  // regenerates coherently (`--revise`) or asserts consistency. A bundle with no
  // ledger (P1-era / hand-authored) has no lineage to check and passes through;
  // the post-approval hash seal is the hard immutability guarantee regardless.
  const generationPath = join(changeDir, 'generation.yaml');
  const generation = readGenerationIfPresent(generationPath);
  let restampStaleLedger = false;
  if (generation !== undefined) {
    const staleness = checkStaleness(changeDir, generation);
    if (staleness.stale) {
      if (options.confirmConsistency !== true) {
        const leaf = staleness.downstream[staleness.downstream.length - 1] ?? '(downstream)';
        throw preconditionError(
          'BUNDLE_STALE',
          `Cannot approve ${change}: ${staleness.editedPath} was edited after ${leaf} was generated — the downstream artifacts may be stale.`,
          `Regenerate coherently with \`crucible propose ${change} --revise "<fix>"\`, or re-run \`crucible approve ${change} --confirm-consistency\` if you have checked the edits are consistent.`,
        );
      }
      // The human asserts consistency: accept the hand-edits as coherent. Defer
      // the re-stamp to the seal step so a declined confirm writes nothing.
      restampStaleLedger = true;
    }
  }

  // The hash scope (design §4): the core bundle artifacts, every spec-delta file
  // under specs/**, and every bound test file (resolved to its path).
  const relpaths = await computeHashScope(root, changeRel, changeDir, oracles, deps.resolve);

  const render = renderReview(change, requirements, oracles, relpaths);

  // Confirm unless --yes. Declining writes nothing (idempotent no-op).
  if (!yes) {
    const confirmed = await deps.confirm();
    if (!confirmed) {
      return { approved: false, render };
    }
  }

  // Confirmed-consistency re-stamp (deferred from the staleness gate): now that
  // we are actually sealing, accept the hand-edits by re-stamping the ledger to
  // the current bytes so future staleness checks start clean from here.
  if (restampStaleLedger) {
    const restamped = stampGeneration(changeDir, change, dependencyOrder(changeDir), deps.now());
    writeFileSync(generationPath, serializeGeneration(restamped), 'utf8');
  }

  // Seal + write. sealBundle emits `files` sorted → byte-stable serialization,
  // so re-approving an unchanged bundle is idempotent (same bytes).
  const approval = sealBundle(root, relpaths, {
    version: APPROVAL_VERSION,
    change,
    approved_by: deps.approvedBy(),
    approved_at: deps.now(),
  });
  writeFileSync(join(changeDir, 'approval.yaml'), serializeApproval(approval), 'utf8');

  // Append the audit event last (design §3 / invariant 1 — never read to gate).
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    { at: deps.now(), cmd: 'approve', summary: `sealed ${relpaths.length} file(s)` },
    'approved',
  );

  return { approved: true, render, sealedFiles: relpaths };
}

/**
 * The P1 review surface: plain terminal text (the rich side-by-side gate is P2).
 * Lists each requirement, each oracle + its binding, and the sealed file set so
 * the human sees exactly what the seal will cover before confirming.
 */
function renderReview(
  change: string,
  requirements: readonly SpecRequirement[],
  oracles: readonly Oracle[],
  relpaths: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`Approve change: ${change}`);
  lines.push('');
  lines.push(`Requirements (${requirements.length}):`);
  for (const req of requirements) {
    lines.push(`  ${req.id} — ${req.title}`);
  }
  lines.push('');
  lines.push(`Oracles (${oracles.length}):`);
  for (const oracle of oracles) {
    const targets = oracle.binding.targets.join(', ');
    lines.push(
      `  ${oracle.id} → ${oracle.binding.requirement} [${oracle.binding.runner}: ${targets}]`,
    );
    lines.push(`    ${oracle.title}`);
  }
  lines.push('');
  lines.push(`Files to seal (${relpaths.length}):`);
  for (const rel of relpaths) {
    lines.push(`  ${rel}`);
  }
  lines.push('');
  return lines.join('\n');
}
