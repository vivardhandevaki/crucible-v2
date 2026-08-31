// `crucible status` — the on-demand dashboard (charter §State & Audit; design
// phase-0-1.md §9). status answers two questions for a change: "where is it?" and
// "what do I run next?" — and, as a side effect, repairs the derived audit trail.
//
// Two invariants shape it:
//
//   - Invariant 1 (artifacts are truth): the reported phase is DERIVED from the
//     artifacts on disk — the change bundle, approval.yaml, and the approval hash
//     check — NEVER read from state.yaml's recorded phase. A hand-edited
//     state.yaml claiming "implemented" over a bundle with no approval is reported
//     as "proposed" (and the file rewritten). status reads state.yaml only to
//     reconcile it, never to decide.
//   - Invariant 11 (convenience is never enforcement): status blocks nothing and
//     unblocks nothing. It always exits 0 on a successful report; the config-differ
//     warning is advisory. The real gates are approve/verify.
//
// It runs NO adapter: bundle "validity" here means the artifacts parse (the
// proposal/oracle/spec-delta grammars), and seal validity is the hash recompute
// (invariant 6). The traceability lint (which needs the adapter's resolver) is
// verify/approve's job — status stays adapter-free so it is always runnable.
//
// Fail-closed (invariant 3) still holds for the TCB artifacts: a malformed bundle
// artifact or a corrupt approval.yaml propagates exit 3 from its parser — status
// does not downgrade a broken sealed artifact to a warning. The ONE thing it
// repairs instead of failing on is a corrupt *derived* state.yaml (that repair is
// precisely status's charter job), isolated in state/reconcile.ts.
//
// Determinism (invariant 12): the only non-deterministic edge — reading the
// merge-base crucible.yaml via git — is injected (`StatusDeps`). The core is a
// pure function of the filesystem.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadProposal } from '../artifacts/proposal.js';
import { loadOracles } from '../artifacts/oracles.js';
import { loadSpecDelta } from '../artifacts/spec-delta.js';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { type ChangeType, readChangeType } from '../changetype/changetype.js';
import { preconditionError } from '../util/errors.js';

/** The phases status can derive from artifacts alone (no oracle run — design §9). */
export type StatusPhase = 'absent' | 'proposed' | 'approval-void' | 'approved' | 'implemented';

/** Injected non-deterministic edge — so status's core stays reproducible. */
export interface StatusDeps {
  /**
   * The merge-base version of `crucible.yaml` (the target-branch config CI would
   * enforce; charter §The Target-Branch Rule). `undefined` when it cannot be
   * determined (not a git repo, no merge base, file absent on the base) — in
   * which case status simply omits the config-differs warning. Injected because
   * the real implementation shells out to git; the core stays deterministic.
   */
  readMergeBaseConfig: () => string | undefined;
}

/** status invocation options. `root` is the repo root the seal is relative to. */
export interface StatusOptions {
  /** Repo root: bundle + approval hashes are resolved relative to this. */
  root: string;
  /** The change to report on (its bundle lives at openspec/changes/<change>/). */
  change: string;
}

/** status outcome: the derived phase, the next command, and advisory warnings. */
export interface StatusReport {
  change: string;
  /** Derived from the artifacts, never from state.yaml's recorded phase. */
  phase: StatusPhase;
  /** The exact next command to run for this phase (a teaching surface). */
  next: string;
  /** Advisory, non-blocking warnings (config-differs). Empty in the clean case. */
  warnings: string[];
  /** Present only when phase === 'approval-void': the sealed files that changed. */
  voidMismatches?: string[];
  /**
   * The change type, read from the `.openspec.yaml` schema pin (design phase-2.md
   * §4) — derived from the artifact, not the state cache (invariant 1). Omitted for
   * an absent change. An unknown pin fails closed at exit 3 like any broken artifact.
   */
  changeType?: ChangeType;
}

/**
 * Report a change's phase + next command and reconcile its state.yaml. Throws
 * `CrucibleError` (exit 2/3) only on a genuinely broken TCB artifact bubbling
 * from a parser (a malformed bundle artifact or corrupt approval.yaml) — never on
 * a corrupt state.yaml, which it repairs. Returns a report the CLI renders; the
 * config-differs warning is advisory and never changes the exit code.
 */
export function status(options: StatusOptions, deps: StatusDeps): StatusReport {
  const { root, change } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  const derived = derivePhase(root, changeDir);

  // State is not an enforcement input or a recovery mechanism. A resumed session
  // reads the same artifact truth as a fresh session, without creating a cache.
  let changeType: ChangeType | undefined;
  if (derived.phase !== 'absent') {
    // Derive the type from the pin (the artifact), not the state cache (invariant 1).
    changeType = readChangeType(changeDir);
  }

  const warnings = configDiffersWarning(root, deps);

  return {
    change,
    phase: derived.phase,
    next: nextCommand(derived.phase, change),
    warnings,
    ...(derived.voidMismatches ? { voidMismatches: derived.voidMismatches } : {}),
    ...(changeType ? { changeType } : {}),
  };
}

/** The derived phase plus, for a void seal, the offending files. */
interface DerivedPhase {
  phase: StatusPhase;
  voidMismatches?: string[];
}

/**
 * Derive the phase from the artifacts on disk (invariant 1) — presence + validity
 * + the approval hash check, no oracle run:
 *
 *   no change dir            → absent
 *   bundle parses, no seal   → proposed
 *   seal present but void    → approval-void
 *   seal valid, no tasks.md  → approved
 *   seal valid + tasks.md    → implemented
 *
 * A malformed bundle artifact or corrupt approval.yaml throws exit 3 from its
 * parser (fail-closed, invariant 3) — status does not mask a broken sealed
 * artifact. "implemented" is deliberately coarse: without running oracles status
 * cannot tell a passing implementation from a red one; verify grades that.
 */
function derivePhase(root: string, changeDir: string): DerivedPhase {
  if (!existsSync(changeDir)) {
    return { phase: 'absent' };
  }

  // Bundle validity = the artifacts parse (fail-closed on malformed, invariant 3).
  validateBundle(changeDir);

  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    return { phase: 'proposed' };
  }

  // A seal exists — recompute every sealed hash (invariant 6). A corrupt
  // approval.yaml fails closed (loadApproval → exit 3); a valid file whose sealed
  // bytes changed is a *void* seal (a diagnosable state, not a parser error).
  const approval = loadApproval(approvalPath);
  const verified = verifyApproval(root, approval);
  if (!verified.valid) {
    return { phase: 'approval-void', voidMismatches: verified.mismatches };
  }

  const tasksPath = join(changeDir, 'tasks.md');
  if (existsSync(tasksPath) && statSync(tasksPath).size > 0) {
    return { phase: 'implemented' };
  }
  return { phase: 'approved' };
}

/** Parse every required bundle artifact so an invalid bundle fails closed here. */
function validateBundle(changeDir: string): void {
  loadProposal(join(changeDir, 'proposal.md'));
  const specsDir = join(changeDir, 'specs');
  const specFiles = existsSync(specsDir) ? markdownFilesUnder(specsDir).sort() : [];
  if (specFiles.length === 0) {
    throw preconditionError(
      'NO_SPEC_DELTA',
      `No spec delta found under ${join(relative(process.cwd(), changeDir), 'specs')}.`,
      'Run `crucible propose` to scaffold the change bundle with a spec delta.',
    );
  }
  for (const file of specFiles) loadSpecDelta(file);
  loadOracles(join(changeDir, 'oracles.md'));
}

/** The exact next command for each phase (architecture.md §2: exit-2-style teaching). */
function nextCommand(phase: StatusPhase, change: string): string {
  switch (phase) {
    case 'absent':
      return `crucible propose ${change} "<intent>"`;
    case 'proposed':
      return `crucible approve ${change}`;
    case 'approval-void':
      // The seal is void; re-review and re-seal before anything downstream runs.
      return `crucible approve ${change}`;
    case 'approved':
      return `crucible implement ${change}`;
    case 'implemented':
      return `crucible verify ${change}`;
  }
}

/**
 * The config-differs warning (charter §The Target-Branch Rule; design §2): if the
 * working-tree crucible.yaml differs from the merge-base version CI would enforce,
 * warn — local verify uses the working tree, but the merge gate uses the target
 * branch's config. Advisory only (invariant 11): a difference never blocks. When
 * either side is unavailable there is nothing to compare, so no warning.
 */
function configDiffersWarning(root: string, deps: StatusDeps): string[] {
  const workingPath = join(root, 'crucible.yaml');
  if (!existsSync(workingPath)) return [];
  const base = deps.readMergeBaseConfig();
  if (base === undefined) return [];
  const working = readFileSync(workingPath, 'utf8');
  if (working === base) return [];
  return [
    'working-tree crucible.yaml differs from the merge-base config. Local verify ' +
      'uses the working tree, but CI enforces the target-branch config (charter ' +
      '§The Target-Branch Rule) — the merge gate may judge this change differently.',
  ];
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
 * Render a status report as plain terminal text (the rich dashboard is P2). Lists
 * the phase, the next command, any void mismatches, and advisory warnings.
 */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Change: ${report.change}`);
  lines.push(`Phase:  ${report.phase}`);
  if (report.changeType) lines.push(`Type:   ${report.changeType}`);
  lines.push(`Next:   ${report.next}`);
  if (report.voidMismatches && report.voidMismatches.length > 0) {
    lines.push('');
    lines.push('Void seal — these sealed files changed or went missing since approval:');
    for (const rel of report.voidMismatches) lines.push(`  ✗ ${rel}`);
  }
  for (const warning of report.warnings) {
    lines.push('');
    lines.push(`warning: ${warning}`);
  }
  return lines.join('\n');
}
