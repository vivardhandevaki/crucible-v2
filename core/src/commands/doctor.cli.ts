// CLI wiring for `crucible doctor` — binds the deterministic core (`doctor`) to
// the one non-deterministic edge (the per-fix y/N prompt) and renders each
// finding as a diff. The core stays reproducible (invariant 12); this shim owns
// readline and `--yes`.
//
// doctor is a maintenance surface, NOT an enforcement gate (enforcement is
// verify/CI). But an unfixed drift finding — a tampered schema bundle, a stale CI
// workflow, an out-of-range OpenSpec pin — is a real problem, so it maps to exit
// 1 (CheckFailure) AFTER the report renders. Optional upstream rubric-line offers
// never affect the exit: skipping one is a legitimate choice (charter §499).
//
// `--yes` auto-confirms every fix (non-interactive), and `--json` makes doctor a
// pure read-only reporter: it emits the findings as JSON and applies nothing (a
// machine consumer inspects; it does not silently mutate the TCB — design §7).

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { CheckFailure } from '../util/errors.js';
import { doctor, type ConfirmFix, type DoctorFinding, type DoctorReport } from './doctor.js';

/** Register the real `doctor` subcommand on the program. */
export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description(
      'Check the installed Crucible setup against the shipped sources; offer fixes as diffs',
    )
    .option('-y, --yes', 'auto-confirm every offered fix (non-interactive)', false)
    .action(async (opts: { yes?: boolean }) => {
      const root = process.cwd();
      const json = program.opts().json === true;

      // Under --json doctor is read-only: it reports, applies nothing. A confirm
      // that always declines keeps the TCB untouched for a machine consumer.
      const confirmFix: ConfirmFix = json
        ? () => false
        : opts.yes === true
          ? () => true
          : confirmFixEdge();

      const report = await doctor({ root }, { confirmFix });

      if (json) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        process.stdout.write(renderReport(report));
      }

      // Exit 1 iff a drift finding was left unresolved (not fixed). Offers/advice
      // never gate the exit; a fully-clean or fully-fixed run is exit 0.
      if (unresolvedDrift(report)) {
        throw new CheckFailure();
      }
    });
}

/** Whether any `drift`-severity finding was not fixed this run. */
function unresolvedDrift(report: DoctorReport): boolean {
  const bySeverity = new Map(report.findings.map((f) => [f.id, f.severity]));
  return report.results.some((r) => r.resolution !== 'fixed' && bySeverity.get(r.id) === 'drift');
}

/**
 * The per-fix decision edge: render the finding's diff and read y/N. A declined
 * fix leaves the file as-is (design §7's "never silent writes"). Prompts appear
 * only for findings that carry a fix — advisories are printed, never prompted.
 */
function confirmFixEdge(): ConfirmFix {
  return async (finding) => {
    process.stdout.write(`\n${severityTag(finding)} ${finding.summary}\n`);
    if (finding.fix) {
      process.stdout.write(renderDiff(finding.fix.current, finding.fix.desired));
    }
    const verb = finding.severity === 'offer' ? 'Add this line' : 'Apply this fix';
    const answer = await ask(`${verb} to ${finding.relpath}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

/** Non-interactive text report — the header, then a line per finding grouped by
 * severity, with each result's resolution. */
function renderReport(report: DoctorReport): string {
  if (report.findings.length === 0) {
    return 'crucible doctor: setup is intact and current — nothing to fix.\n';
  }
  const resolution = new Map(report.results.map((r) => [r.id, r.resolution]));
  const lines: string[] = ['crucible doctor: findings\n'];
  for (const f of report.findings) {
    const outcome = resolution.get(f.id) ?? 'reported';
    lines.push(`  ${severityTag(f)} ${f.summary}  [${outcome}]`);
  }
  const bySeverity = new Map(report.findings.map((f) => [f.id, f.severity]));
  const fixed = report.results.filter((r) => r.resolution === 'fixed').length;
  const unresolvedDrift = report.results.filter(
    (r) => r.resolution !== 'fixed' && bySeverity.get(r.id) === 'drift',
  ).length;
  lines.push('');
  lines.push(
    fixed > 0 ? `Applied ${fixed} fix(es).` : 'No fixes applied.',
    unresolvedDrift > 0
      ? `${unresolvedDrift} drift finding(s) remain — accept the fix, or \`crucible doctor --yes\` to apply all.`
      : 'No drift remains.',
  );
  return lines.join('\n') + '\n';
}

function severityTag(finding: DoctorFinding): string {
  switch (finding.severity) {
    case 'drift':
      return '✗ drift';
    case 'offer':
      return '+ offer';
    case 'advise':
      return 'ℹ advise';
  }
}

/**
 * A compact line-level diff: trim the common prefix/suffix so only the changed
 * region shows, then `-`/`+` the differing lines. Display-only (convenience) —
 * the core carries the authoritative current/desired bytes.
 */
function renderDiff(current: string | null, desired: string): string {
  if (current === null) {
    return (
      desired
        .split('\n')
        .map((l) => `  + ${l}`)
        .join('\n') + '\n'
    );
  }
  const a = current.split('\n');
  const b = desired.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  if (start > 0) out.push(`  … ${start} unchanged line(s)`);
  for (let i = start; i < endA; i++) out.push(`  - ${a[i]}`);
  for (let i = start; i < endB; i++) out.push(`  + ${b[i]}`);
  const trailing = a.length - endA;
  if (trailing > 0) out.push(`  … ${trailing} unchanged line(s)`);
  return out.join('\n') + '\n';
}

/** One-shot readline question, opening + closing an interface per prompt. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
