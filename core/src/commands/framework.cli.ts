import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { parseFrameworkSource } from '../framework/pin.js';
import { frameworkUpgrade } from './framework-upgrade.js';
import { invalidInputError } from '../util/errors.js';

/** Register the restricted consumer framework-pin upgrade transaction. */
export function registerFramework(program: Command): void {
  const framework = program
    .command('framework')
    .description('Manage the pinned Crucible framework');
  framework
    .command('upgrade')
    .description('Refresh only the framework pin and managed workflows')
    .requiredOption('--source <owner/repository@sha>', 'candidate immutable framework source')
    .action((opts: { source: string }) => {
      const root = process.cwd();
      const report = frameworkUpgrade({
        root,
        pin: parseFrameworkSource(opts.source),
        trackedDirty: trackedDirty(root),
      });
      if (program.opts().json === true) {
        process.stdout.write(JSON.stringify(report) + '\n');
        return;
      }
      for (const action of report.actions)
        process.stdout.write(action.kind + '  ' + action.relpath + '\n');
      process.stdout.write(
        'Framework upgrade is staged. Review the exact allowlisted diff before opening a PR.\n',
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
      'FRAMEWORK_UPGRADE_GIT_UNAVAILABLE',
      'Could not determine tracked worktree state: ' + messageOf(cause),
      'Run framework upgrade from a Git worktree with Git available.',
    );
  }
  return output !== '';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
