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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import {
  diagnoseCiProtection,
  type CiProtectionObservation,
  type CiProtectionReport,
} from '../ci/diagnostics.js';
import { CheckFailure, invalidInputError } from '../util/errors.js';
import { doctor, type ConfirmFix, type DoctorFinding, type DoctorReport } from './doctor.js';

/** Register the real `doctor` subcommand on the program. */
export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description(
      'Check the installed Crucible setup against the shipped sources; offer fixes as diffs',
    )
    .option('-y, --yes', 'auto-confirm every offered fix (non-interactive)', false)
    .option('--ci', 'report the CI protection grade and supporting evidence', false)
    .option(
      '--ci-observation <path>',
      'strict JSON observation of remote ruleset/App/local protection evidence',
    )
    .action(async (opts: { yes?: boolean; ci?: boolean; ciObservation?: string }) => {
      const root = process.cwd();
      const json = program.opts().json === true;

      if (opts.ci === true) {
        const ciReport = diagnoseCiProtection(
          opts.ciObservation ? readObservation(opts.ciObservation) : observeLocalCi(root),
        );
        process.stdout.write(json ? `${JSON.stringify(ciReport)}\n` : renderCiProtection(ciReport));
        if (ciReport.state !== 'valid') throw new CheckFailure();
        return;
      }
      if (opts.ciObservation) {
        throw invalidInputError(
          'CI_OBSERVATION_WITHOUT_DIAGNOSTIC',
          '--ci-observation is valid only with `crucible doctor --ci`.',
          'Add --ci, or omit --ci-observation for the ordinary installation doctor.',
        );
      }

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

function readObservation(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (cause) {
    return { malformed_observation: messageOf(cause) };
  }
}

/** Local evidence can prove only the candidate-controlled advisory offering. */
function observeLocalCi(root: string): CiProtectionObservation | unknown {
  const sha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return {
      version: 1,
      access: 'inaccessible',
      repository: repositoryName(root),
      target_branch: branchName(root),
      target_sha: '0'.repeat(40),
      observed_sha: '0'.repeat(40),
      installation: { kind: 'absent' },
    } satisfies CiProtectionObservation;
  }
  const workflowPath = join(root, '.github', 'workflows', 'crucible.yml');
  if (!existsSync(workflowPath)) {
    return {
      version: 1,
      access: 'ok',
      repository: repositoryName(root),
      target_branch: branchName(root),
      target_sha: sha,
      observed_sha: sha,
      installation: { kind: 'absent' },
    } satisfies CiProtectionObservation;
  }
  const bytes = readFileSync(workflowPath);
  let eventNames: ('pull_request' | 'merge_group' | 'pull_request_target')[] = [];
  try {
    const yaml = parseYaml(bytes.toString('utf8')) as { on?: Record<string, unknown> };
    eventNames = Object.keys(yaml.on ?? {})
      .filter(
        (name): name is 'pull_request' | 'merge_group' | 'pull_request_target' =>
          name === 'pull_request' || name === 'merge_group' || name === 'pull_request_target',
      )
      .sort();
  } catch {
    // Empty events make the strict diagnostic partial; malformed YAML is never healthy.
  }
  return {
    version: 1,
    access: 'ok',
    repository: repositoryName(root),
    target_branch: branchName(root),
    target_sha: sha,
    observed_sha: sha,
    installation: {
      kind: 'repository_local',
      workflow_path: '.github/workflows/crucible.yml',
      workflow_content_sha256: createHash('sha256').update(bytes).digest('hex'),
      events: eventNames,
      latest_check: 'unknown',
    },
  } satisfies CiProtectionObservation;
}

function renderCiProtection(report: CiProtectionReport): string {
  const lines = [
    `crucible doctor --ci: ${report.grade} (${report.state})`,
    `  repository: ${report.repository ?? '(unknown)'}`,
    `  target: ${report.target_branch ?? '(unknown)'}${report.target_sha ? ` @ ${report.target_sha}` : ''}`,
  ];
  for (const item of report.capabilities) {
    const mark = item.status === 'pass' ? '✓' : item.status === 'advisory' ? 'ℹ' : '✗';
    lines.push(`  ${mark} ${item.capability}: ${item.evidence}`);
    if (item.status !== 'pass') lines.push(`    remedy: ${item.remediation}`);
  }
  return `${lines.join('\n')}\n`;
}

function repositoryName(root: string): string {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  const matched = /(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return matched?.[1] ?? 'local/repository';
}

function branchName(root: string): string {
  return git(root, ['branch', '--show-current']) || 'HEAD';
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
