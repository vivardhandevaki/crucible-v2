import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { parseFrameworkSource, type FrameworkPin } from '../framework/pin.js';
import { invalidInputError } from '../util/errors.js';
import { reviewPostureBootstrap } from './review-posture-bootstrap.js';

export function registerReviewPostureBootstrap(program: Command): void {
  const posture = program
    .command('review-posture')
    .description('Manage exceptional review-posture transitions');
  posture
    .command('bootstrap')
    .description('Stage the one manual P4-26 solo-posture root bootstrap')
    .requiredOption('--source <owner/repository@sha>', 'candidate immutable framework source')
    .option('--acknowledge-root-bootstrap', 'acknowledge the one manual root-bootstrap procedure')
    .action((opts: { source: string; acknowledgeRootBootstrap?: boolean }) => {
      const root = process.cwd();
      const pin = parseFrameworkSource(opts.source);
      assertFrameworkSourceReachable(pin);
      const report = reviewPostureBootstrap({
        root,
        pin,
        trackedDirty: trackedDirty(root),
        ...(opts.acknowledgeRootBootstrap === true ? { acknowledgeRootBootstrap: true } : {}),
      });
      if (program.opts().json === true) {
        process.stdout.write(JSON.stringify(report) + '\n');
        return;
      }
      for (const action of report.actions)
        process.stdout.write(action.kind + '  ' + action.relpath + '\n');
      for (const instruction of report.operatorInstructions)
        process.stdout.write('! ' + instruction + '\n');
      process.stdout.write(
        'Review-posture root bootstrap is staged. Review the exact allowlisted diff before opening a PR.\n',
      );
    });
}

function trackedDirty(root: string): boolean {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (cause) {
    throw invalidInputError(
      'REVIEW_POSTURE_BOOTSTRAP_GIT_UNAVAILABLE',
      'Could not determine tracked worktree state: ' + messageOf(cause),
      'Run review-posture bootstrap from a Git worktree with Git available.',
    );
  }
  return output !== '';
}

function assertFrameworkSourceReachable(pin: FrameworkPin): void {
  let output: string;
  try {
    output = execFileSync('git', ['ls-remote', 'https://github.com/' + pin.repository + '.git'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw invalidInputError(
      'REVIEW_POSTURE_BOOTSTRAP_SOURCE_UNREACHABLE',
      'Could not reach the requested framework source: ' + messageOf(cause),
      'Verify the repository and immutable commit are reachable, then retry.',
    );
  }
  if (!output.split(/\r?\n/).some((line) => line.split('\t')[0] === pin.commit)) {
    throw invalidInputError(
      'REVIEW_POSTURE_BOOTSTRAP_SOURCE_COMMIT_UNREACHABLE',
      'The requested framework commit is not advertised by ' + pin.repository + '.',
      'Use a reachable immutable commit from the requested framework repository.',
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
