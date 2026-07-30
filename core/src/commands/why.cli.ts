// CLI wiring for `crucible why` — binds the deterministic `why` core to the same
// live edges `verify` uses (the adapter client's dry-run resolver + oracle
// runner, the git diff-facts edge, the reproduction worktree, and the adversarial
// reviewer under --review). `why` re-runs the verify core to get the authoritative
// report, then traces the requested id back to its source; this shim supplies the
// non-deterministic edges at invocation time (invariant 12 keeps the core pure).
//
// `why` is a read-only explainer (invariant 11 — it blocks nothing): a successful
// trace is exit 0 whether the subject is red or green. An UNKNOWN id is a genuine
// precondition failure (exit 2, with the available ids); a missing bundle or
// malformed artifact bubbles from the shared verify pass (exit 2/3) unchanged.
//
// Like verify, the live resolver/runner spawn the pinned adapter, which `init`
// records; until then they fail closed naming the missing piece rather than
// pretending the trace ran against a real adapter. The `why` core is complete and
// directly tested (why.test.ts) against injected edges.

import type { Command } from 'commander';
import { resolveAgentRuntime } from '../substrate/runtime.js';
import { why, renderWhy, type WhyDeps } from './why.js';
import { computeDiffFacts, defaultBase } from './diff-facts.js';
import { review } from './review.js';
import { gitHead, reviewModel } from './review.cli.js';
import { liveWorktreeGit, runReproductionOnBase } from '../reproduction/reproduction.js';
import {
  loadEnforcementConfig,
  resolveEnforcementRoot,
  type EnforcementConfig,
} from '../config/enforcement.js';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';

/** Register the real `why` subcommand on the program. */
export function registerWhy(program: Command): void {
  program
    .command('why')
    .description('Trace a verify finding back to its source (oracle → binding → adapter → rubric)')
    .argument('<change>', 'the change name whose verdict to trace (openspec/changes/<change>/)')
    .argument(
      '<id>',
      'the subject to explain: a check name, an ORC/REQ id, a rubric line, or a sealed file',
    )
    .option(
      '--diff-base <ref>',
      'the git ref to diff against for tier/cap computation ' +
        '(CI passes origin/<base_ref>; default: merge-base of HEAD and origin/HEAD)',
    )
    .option(
      '--review',
      'also run the adversarial reviewer so rubric findings are traceable ' +
        '(otherwise a rubric id traces only to its line in the law)',
    )
    .action(async (change: string, id: string, opts: { diffBase?: string; review?: boolean }) => {
      const root = process.cwd();

      // Enforcement config: `--config-from` (CI target-branch checkout) wins, else
      // the working tree (invariant 7). Supplied so the trace matches what verify
      // would decide (tier/cap findings become traceable too).
      const configRoot = resolveEnforcementRoot(program.opts().configFrom, root);
      const config: EnforcementConfig = loadEnforcementConfig(configRoot);

      const trace = await why(
        { root, change, id, config },
        liveDeps(root, opts.diffBase, { change, withReview: opts.review === true }),
      );

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(trace) + '\n');
      } else {
        process.stdout.write(renderWhy(trace) + '\n');
      }
      // No verdict: `why` explains, never blocks (invariant 11) — a successful
      // trace is exit 0. Unknown-id / broken-bundle errors throw from the core.
    });
}

/** The live dependencies for a real why invocation — verify's edges, verbatim. */
function liveDeps(
  root: string,
  diffBase: string | undefined,
  reviewOpts: { change: string; withReview: boolean },
): WhyDeps {
  const adapter = loadPinnedAdapterClient(root);
  return {
    resolve: (targets) => adapter.resolve(targets),
    run: (oracles) => adapter.run(oracles),
    diffFacts: () => computeDiffFacts(root, diffBase),
    runOnBase: (oracles) =>
      runReproductionOnBase(
        { root, base: diffBase ?? defaultBase(root), oracles },
        {
          git: liveWorktreeGit(root),
          resolve: (targets) => adapter.resolve(targets),
          runIn: (worktreePath, reproductionOracles) =>
            loadPinnedAdapterClient(root, worktreePath).run(reproductionOracles),
        },
      ),
    ...(reviewOpts.withReview
      ? {
          review: () =>
            review(
              {
                root,
                change: reviewOpts.change,
                model: reviewModel(root),
                base: diffBase ?? defaultBase(root),
                head: gitHead(root),
              },
              {
                substrate: resolveAgentRuntime(root, 'review').substrate,
                now: () => new Date().toISOString(),
              },
            ),
        }
      : {}),
  };
}
