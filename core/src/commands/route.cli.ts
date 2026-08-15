// CLI wiring for the P4-24 independent route authority. Unlike `verify`, this
// command never loads an adapter, executes an oracle, or runs project code: it
// reads the exact candidate diff and artifacts as data, applies target-branch
// enforcement config, and emits the deterministic merge route.

import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { loadEnforcementConfig, resolveEnforcementRoot } from '../config/enforcement.js';
import { computeDiffFacts } from './diff-facts.js';
import { assertReviewPostureCongruence } from './review-posture.js';
import { aggregateRoute, routeDecision } from './route-decision.js';
import { invalidInputError } from '../util/errors.js';

/** Register `crucible route` — the credential-separated deterministic router. */
export function registerRoute(program: Command): void {
  program
    .command('route')
    .description('Recompute deterministic merge routing without executing project code')
    .requiredOption('--diff-base <ref>', 'the exact base ref to compare against')
    .action((opts: { diffBase: string }) => {
      const root = process.cwd();
      const configRoot = resolveEnforcementRoot(program.opts().configFrom, root);
      const config = loadEnforcementConfig(configRoot);
      assertReviewPostureCongruence(configRoot, config);
      const facts = computeDiffFacts(root, opts.diffBase);
      const changes = changedBundles(root, opts.diffBase);
      const routing = aggregateRoute(changes.map((change) => routeDecision(root, change, config, facts)));
      const result = { changes, routing };
      process.stdout.write(program.opts().json === true ? JSON.stringify(result) + '\n' : `${routing.decision}\n`);
    });
}

/** Read changed bundle names from Git's NUL-delimited canonical path output. */
function changedBundles(root: string, base: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (cause) {
    throw invalidInputError(
      'DIFF_UNCOMPUTABLE',
      `Could not enumerate governed changes: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Ensure the exact diff base is fetched and retry with `crucible route --diff-base <ref>`.',
    );
  }
  if (raw === '') return [];
  if (!raw.endsWith('\0')) {
    throw invalidInputError(
      'DIFF_UNCOMPUTABLE',
      'Could not enumerate governed changes: git path output was not NUL terminated.',
      'Ensure git produced complete diff data and retry.',
    );
  }
  return [...new Set(
    raw
      .slice(0, -1)
      .split('\0')
      .map((path) => /^openspec\/changes\/([^/]+)\//.exec(path)?.[1])
      .filter((change): change is string => change !== undefined),
  )].sort();
}
