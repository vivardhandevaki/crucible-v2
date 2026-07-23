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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadSpecDelta, type SpecRequirement } from '../artifacts/spec-delta.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { appendStateEvent } from '../state/state.js';
import { preconditionError } from '../util/errors.js';
import { writeFileSync } from 'node:fs';

/** The P1 approval.yaml schema version (design §3). */
const APPROVAL_VERSION = 1;

/** The artifacts that always live directly in a change bundle dir. */
const CORE_ARTIFACTS = ['proposal.md', 'design.md', 'oracles.md'] as const;

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
  const requirements = loadAllRequirements(changeDir, changeRel);
  const oracles = loadOracles(join(changeDir, 'oracles.md'));

  // Precondition: the traceability lint must be green (invariant 5). A red lint
  // is a bundle that promises something no executable check covers — refuse to
  // seal it, and name the fix.
  const lint = await lintTraceability(requirements, oracles, deps.resolve);
  if (!lint.ok) {
    const detail = lint.findings.map((f) => `  ✗ ${f.message}`).join('\n');
    throw preconditionError(
      'LINT_RED',
      `Cannot approve ${change}: traceability lint failed —\n${detail}`,
      `Fix the bundle and re-run \`crucible propose ${change} --revise "<fix>"\`, then \`crucible approve ${change}\`.`,
    );
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
 * Parse every spec-delta markdown file under the change's `specs/**` into one
 * ordered requirement list. A bundle with no spec delta at all is a precondition
 * failure (exit 2) — approve has nothing to gate. Order is deterministic:
 * files sorted by relative path, requirements in source order within each.
 */
function loadAllRequirements(changeDir: string, changeRel: string): SpecRequirement[] {
  const specsDir = join(changeDir, 'specs');
  const specFiles = existsSync(specsDir) ? markdownFilesUnder(specsDir).sort() : [];
  if (specFiles.length === 0) {
    throw preconditionError(
      'NO_SPEC_DELTA',
      `No spec delta found under ${join(changeRel, 'specs')}.`,
      'Run `crucible propose` to scaffold the change bundle with a spec delta.',
    );
  }
  return specFiles.flatMap((file) => loadSpecDelta(file));
}

/**
 * The sealed relpaths (design §4), relative to `root`, deterministically sorted:
 *   proposal.md, design.md, oracles.md, every specs/** markdown, every bound
 *   test file. Bound test files come from the resolver's `targetFile` — the core
 *   never parses the opaque `target` syntax (charter §Bindings). A `found`
 *   target that reports no `targetFile` is a fail-closed precondition (exit 2):
 *   we cannot seal a check whose file we cannot locate.
 */
async function computeHashScope(
  root: string,
  changeRel: string,
  changeDir: string,
  oracles: readonly Oracle[],
  resolve: ResolveFn,
): Promise<string[]> {
  const covered = new Set<string>();

  for (const artifact of CORE_ARTIFACTS) {
    covered.add(join(changeRel, artifact));
  }
  for (const abs of markdownFilesUnder(join(changeDir, 'specs'))) {
    covered.add(relative(root, abs));
  }

  const targets = dedupeTargets(oracles);
  if (targets.length > 0) {
    const resolutions = await resolve(targets);
    const byTarget = new Map(resolutions.map((r) => [r.target, r] as const));
    for (const target of targets) {
      const resolution = byTarget.get(target);
      if (resolution === undefined || resolution.status !== 'found' || !resolution.targetFile) {
        throw preconditionError(
          'UNRESOLVED_TARGET_FILE',
          `Cannot approve: bound target ${target} did not resolve to a file to seal.`,
          'Re-run `crucible propose --revise` so every oracle binds an addressable test.',
        );
      }
      covered.add(resolution.targetFile);
    }
  }

  return [...covered].sort();
}

/** Distinct oracle targets in first-appearance order (matches lint dedupe). */
function dedupeTargets(oracles: readonly Oracle[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const oracle of oracles) {
    for (const target of oracle.binding.targets) {
      if (!seen.has(target)) {
        seen.add(target);
        ordered.push(target);
      }
    }
  }
  return ordered;
}

/** All `.md` files under `dir` (recursive), absolute paths. Empty if absent. */
function markdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...markdownFilesUnder(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
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
