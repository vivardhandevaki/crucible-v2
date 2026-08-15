import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadEnforcementConfig, resolveEnforcementRoot } from '../config/enforcement.js';
import { invalidInputError } from '../util/errors.js';
import { classifyCiAuthority } from './ci-authority.js';

/** Register CI-only authority classification. It is intentionally separate from
 * local verify/route so CI cannot inherit their pre-approval convenience path. */
export function registerCi(program: Command): void {
  const ci = program.command('ci').description('CI-only fail-closed enforcement entry points');
  ci.command('authority')
    .description('Classify a NUL-delimited base-to-head path manifest before CI enforcement')
    .requiredOption(
      '--changed-paths <file>',
      'NUL-delimited changed paths produced by the workflow',
    )
    .action((opts: { changedPaths: string }) => {
      const headRoot = process.cwd();
      const baseRoot = resolveEnforcementRoot(program.opts().configFrom, headRoot);
      const result = classifyCiAuthority({
        baseRoot,
        headRoot,
        config: loadEnforcementConfig(baseRoot),
        changedPaths: readChangedPaths(opts.changedPaths),
      });
      process.stdout.write(
        program.opts().json === true ? JSON.stringify(result) + '\n' : result.lane + '\n',
      );
    });
}

/** Strict NUL-only transport: newline splitting silently corrupts legal Git paths. */
export function readChangedPaths(path: string): string[] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (cause) {
    throw invalidInputError(
      'CI_CHANGED_PATHS_UNREADABLE',
      'Could not read the CI changed-path manifest: ' + messageOf(cause),
      'Ensure the authority workflow writes and passes its NUL-delimited manifest.',
    );
  }
  if (raw.length === 0 || raw[raw.length - 1] !== 0) {
    throw invalidInputError(
      'CI_CHANGED_PATHS_MALFORMED',
      'The CI changed-path manifest must be non-empty and NUL terminated.',
      'Ensure the authority workflow uses git diff --name-only -z.',
    );
  }
  return raw.subarray(0, -1).toString('utf8').split('\0');
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
