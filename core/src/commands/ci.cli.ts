import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { establishCiTrustPartition } from '../ci/trust.js';
import { CheckFailure, invalidInputError } from '../util/errors.js';
import { runLiveCiVerification } from './ci-verify.js';

interface CiVerifyCliOptions {
  event: 'pull_request' | 'merge_group';
  repository: string;
  baseRepository: string;
  baseRef: string;
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  eventSha: string;
  candidateRoot: string;
  targetTipRoot: string;
}

/** Internal transport command invoked by a separately trusted workflow from checkout B. */
export function registerCi(program: Command): void {
  const ci = program.command('ci').description('Trusted CI transport commands');
  ci.command('verify')
    .description('Verify exact candidate H using trust inputs from exact base B')
    .requiredOption('--event <event>', 'pull_request or merge_group')
    .requiredOption('--repository <owner/name>', 'target repository from the event')
    .requiredOption('--base-repository <owner/name>', 'base repository from the event')
    .requiredOption('--base-ref <ref>', 'full target branch ref from the event')
    .requiredOption('--base-sha <sha>', 'exact event base commit B')
    .requiredOption('--candidate-repository <owner/name>', 'candidate repository from the event')
    .requiredOption('--candidate-sha <sha>', 'exact candidate commit H')
    .requiredOption('--event-sha <sha>', 'GITHUB_SHA recorded for the event')
    .requiredOption('--candidate-root <path>', 'checkout root for exact H')
    .requiredOption('--target-tip-root <path>', 'independent checkout of the current target tip')
    .action(async (raw: CiVerifyCliOptions) => {
      const baseRoot = resolve(process.cwd());
      const candidateRoot = resolve(raw.candidateRoot);
      const targetTipRoot = resolve(raw.targetTipRoot);
      const partition = establishCiTrustPartition({
        version: 1,
        event: raw.event,
        repository: raw.repository,
        base_repository: raw.baseRepository,
        base_ref: raw.baseRef,
        base_sha: raw.baseSha,
        candidate_repository: raw.candidateRepository,
        candidate_sha: raw.candidateSha,
        event_sha: raw.eventSha,
        observed_target_sha: gitHead(targetTipRoot),
        base_checkout_sha: gitHead(baseRoot),
        candidate_checkout_sha: gitHead(candidateRoot),
        base_root: baseRoot,
        candidate_root: candidateRoot,
        target_tip_root: targetTipRoot,
      });

      const report = await runLiveCiVerification(partition);
      if (program.opts().json === true) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        process.stdout.write(renderCiReport(report));
      }
      if (report.verdict === 'fail') throw new CheckFailure();
    });
}

function gitHead(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (cause) {
    throw invalidInputError(
      'CI_CHECKOUT_UNREADABLE',
      `Cannot resolve an exact checkout commit at ${root}: ${messageOf(cause)}.`,
      'Re-run the trusted workflow so it can create fresh exact B, H, and target-tip checkouts.',
    );
  }
}

function renderCiReport(report: Awaited<ReturnType<typeof runLiveCiVerification>>): string {
  const lines = [
    `crucible ci verify: ${report.verdict.toUpperCase()}`,
    `  event: ${report.event}`,
    `  B: ${report.base_sha}`,
    `  H: ${report.candidate_sha}`,
  ];
  for (const change of report.changes) {
    lines.push(`  ${change.entry}: ${change.report.verdict}`);
  }
  return `${lines.join('\n')}\n`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
