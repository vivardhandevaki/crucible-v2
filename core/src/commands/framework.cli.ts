import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { parseFrameworkSource, type FrameworkPin } from '../framework/pin.js';
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
    .option(
      '--acknowledge-legacy-bootstrap',
      'acknowledge the one non-authoritative legacy bridge and its manual merge procedure',
    )
    .action((opts: { source: string; acknowledgeLegacyBootstrap?: boolean }) => {
      const root = process.cwd();
      const pin = parseFrameworkSource(opts.source);
      assertFrameworkSourceReachable(pin, liveLsRemote);
      const report = frameworkUpgrade({
        root,
        pin,
        trackedDirty: trackedDirty(root),
        ...(opts.acknowledgeLegacyBootstrap === true ? { acknowledgeLegacyBootstrap: true } : {}),
      });
      if (program.opts().json === true) {
        process.stdout.write(JSON.stringify(report) + '\n');
        return;
      }
      for (const action of report.actions)
        process.stdout.write(action.kind + '  ' + action.relpath + '\n');
      for (const instruction of report.operatorInstructions ?? [])
        process.stdout.write('! ' + instruction + '\n');
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

export function assertFrameworkSourceReachable(
  pin: FrameworkPin,
  lsRemote: (repository: string) => string,
): void {
  let output: string;
  try {
    output = lsRemote(pin.repository);
  } catch (cause) {
    throw invalidInputError(
      'FRAMEWORK_SOURCE_UNREACHABLE',
      'Could not reach the requested framework source: ' + messageOf(cause),
      'Verify the repository and immutable commit are reachable, then retry.',
    );
  }
  const found = output.split(/\r?\n/).some((line) => line.split('\t')[0] === pin.commit);
  if (!found) {
    throw invalidInputError(
      'FRAMEWORK_SOURCE_COMMIT_UNREACHABLE',
      'The requested framework commit is not advertised by ' + pin.repository + '.',
      'Use a reachable immutable commit from the requested framework repository.',
    );
  }
}

function liveLsRemote(repository: string): string {
  return execFileSync('git', ['ls-remote', 'https://github.com/' + repository + '.git'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
