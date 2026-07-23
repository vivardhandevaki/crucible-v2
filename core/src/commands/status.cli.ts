// CLI wiring for `crucible status` — binds the deterministic core (`status`) to
// its one non-deterministic edge: reading the merge-base crucible.yaml via git,
// for the config-differs warning. The core stays testable and reproducible
// (invariant 12); this shim supplies the live git read at invocation time.
//
// status is a convenience dashboard (invariant 11): it blocks nothing and always
// exits 0 on a successful report — there is no CheckFailure/verdict path here. A
// genuinely broken TCB artifact (malformed bundle, corrupt approval.yaml) still
// throws a CrucibleError (exit 2/3) from the core and is handled by the runner.
//
// The merge-base read is best-effort: any git failure (not a repo, no target
// branch, no crucible.yaml on the base) yields `undefined`, and the core simply
// omits the warning. A convenience warning must never itself become a blocker.

import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { status, renderStatus, type StatusDeps } from './status.js';

/** Target-branch refs tried, in order, when locating the merge-base config. */
const TARGET_REFS = ['main', 'origin/main', 'master', 'origin/master'] as const;

/** Register the real `status` subcommand on the program. */
export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show the change phase and the next command to run')
    .argument('<change>', 'the change name to report on (openspec/changes/<change>/)')
    .action((change: string) => {
      const root = process.cwd();
      const report = status({ root, change }, liveDeps(root));

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        process.stdout.write(renderStatus(report) + '\n');
      }
      // No verdict: status never blocks (invariant 11) — a successful report is
      // exit 0, warnings and all. Broken-artifact errors throw from the core.
    });
}

/** Live dependencies for a real status invocation. */
function liveDeps(root: string): StatusDeps {
  return { readMergeBaseConfig: () => readMergeBaseConfig(root) };
}

/**
 * Read the crucible.yaml CI would enforce: the version at the merge-base of HEAD
 * and the target branch (charter §The Target-Branch Rule). Best-effort — any git
 * error returns `undefined` so the config-differs warning is simply omitted
 * rather than turned into a failure (invariant 11).
 */
function readMergeBaseConfig(root: string): string | undefined {
  for (const ref of TARGET_REFS) {
    const base = git(root, ['merge-base', 'HEAD', ref]);
    if (base === undefined) continue;
    const content = git(root, ['show', `${base.trim()}:crucible.yaml`]);
    if (content !== undefined) return content;
  }
  return undefined;
}

/** Run a git command in `root`, returning stdout or `undefined` on any failure. */
function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}
