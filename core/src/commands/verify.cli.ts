// CLI wiring for `crucible verify` — binds the deterministic core (`verify`) to
// the real, non-deterministic edges (the adapter client's dry-run resolver and
// oracle runner, plus the git diff-facts edge) and prints the report. The core
// stays testable and reproducible (invariant 12); this file is the thin shim that
// supplies live dependencies at invocation time and maps the verdict to the exit
// code.
//
// This is the *authoritative* enforcement path (design phase-2.md §2): it loads
// the enforcement config — from `--config-from` in CI (the target-branch rule,
// invariant 7) or the working tree locally — and assembles the diff facts from
// git, so verify recomputes the tier (invariant 8), enforces the per-tier diff
// cap, and emits the routing decision CI's `route` job consumes. In this context
// an uncomputable diff is exit 3 (fail-closed, invariant 3) — never "assume
// trivial"; the git edge below throws rather than guessing.
//
// A red verdict is signaled with `CheckFailure` (exit 1) AFTER the report is
// rendered — so `--json` writes the report to stdout, not an error object. A
// genuine error (missing bundle, malformed artifact, broken adapter, uncomputable
// diff) still throws a `CrucibleError` (exit 2/3) from the core/edges and is
// handled by the runner.
//
// The live resolver/runner must spawn the pinned adapter, which `init` records
// (P2). Until then those deps fail closed with a message naming the missing piece
// rather than pretending the checks ran. The `verify` core itself is complete and
// directly tested (verify.test.ts); the tracer (P1-16) wires a real stub-adapter
// client into these deps.

import { join } from 'node:path';
import type { Command } from 'commander';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { verify, type VerifyDeps } from './verify.js';
import { computeDiffFacts, defaultBase } from './diff-facts.js';
import { liveWorktreeGit, runReproductionOnBase } from '../reproduction/reproduction.js';
import { renderReport } from '../verifyx/report.js';
import {
  loadEnforcementConfig,
  resolveEnforcementRoot,
  type EnforcementConfig,
} from '../config/enforcement.js';
import { recordSnapshotTier } from '../state/state.js';
import { createLiveNotifier } from '../notify/live.js';
import { CheckFailure } from '../util/errors.js';

/** Register the real `verify` subcommand on the program. */
export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('Run lint, oracles, tier/diff-cap, and hash checks; report green/red')
    .argument('<change>', 'the change name to verify (openspec/changes/<change>/)')
    .option(
      '--diff-base <ref>',
      'the git ref to diff against for tier/cap computation ' +
        '(CI passes origin/<base_ref>; default: merge-base of HEAD and origin/HEAD)',
    )
    .action(async (change: string, opts: { diffBase?: string }) => {
      const root = process.cwd();

      // Enforcement config: `--config-from` (the CI target-branch checkout) wins,
      // else the working tree (invariant 7). Missing/malformed → exit 2/3 from the
      // loader — verify is an enforcement command; it does not run without config.
      const configRoot = resolveEnforcementRoot(program.opts().configFrom, root);
      const config: EnforcementConfig = loadEnforcementConfig(configRoot);

      const report = await verify({ root, change, config }, liveDeps(root, opts.diffBase));

      // Best-effort (invariant 11): cache the recomputed tier for `status` to
      // display. Never blocks the verdict — a display cache is convenience.
      if (report.tier) {
        try {
          recordSnapshotTier(join(root, 'openspec', 'changes', change, 'state.yaml'), report.tier);
        } catch {
          /* convenience-never-enforcement: a failed cache write is silent. */
        }
      }

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        process.stdout.write(renderReport(report) + '\n');
      }

      // Announce the verdict (charter §Notify Hooks; P2-15). Fire-and-forget from
      // the CLI edge so the deterministic verify core (invariant 12) stays pure of
      // the notify seam. The dispatcher never throws (invariant 11); we await it so
      // pending hooks complete before the process exits on a red verdict. The
      // working-tree convenience config drives it — notify is not enforcement, so
      // invariant 7's target-branch rule does not apply to the announcement channel.
      await createLiveNotifier(root)({
        kind: 'verify',
        change,
        summary: `${report.verdict.toUpperCase()}${report.tier ? ` — tier ${report.tier}` : ''}`,
      });

      // A red verdict exits 1 (architecture.md §2) — a verdict, not an error. The
      // report is already printed; CheckFailure carries the exit code silently.
      if (report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** The live dependencies for a real verify invocation. */
function liveDeps(root: string, diffBase: string | undefined): VerifyDeps {
  const adapter = loadPinnedAdapterClient(root);
  return {
    resolve: (targets) => adapter.resolve(targets),
    run: (oracles) => adapter.run(oracles),
    diffFacts: () => computeDiffFacts(root, diffBase),
    // The bugfix red-on-base run: check out the merge-base into a throwaway
    // worktree (real git edge) and run the reproduction oracles there. The
    // adapter that resolves + runs the targets is still `init`-pinned (P2), so
    // resolve/runIn fail closed exactly like the HEAD run above until then; the
    // worktree plumbing is wired and proven by the P2-08 reproduction tests.
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
  };
}
