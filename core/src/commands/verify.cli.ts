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

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Command } from 'commander';
import { verify, type DiffFacts, type VerifyDeps } from './verify.js';
import { review } from './review.js';
import { gitHead, reviewModel } from './review.cli.js';
import { ClaudeCodeSubstrate } from '../substrate/claude-code.js';
import { liveWorktreeGit, runReproductionOnBase } from '../reproduction/reproduction.js';
import { renderReport } from '../verifyx/report.js';
import {
  loadEnforcementConfig,
  resolveEnforcementRoot,
  type EnforcementConfig,
} from '../config/enforcement.js';
import { recordSnapshotTier } from '../state/state.js';
import { CheckFailure, invalidInputError, preconditionError } from '../util/errors.js';

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
    .option(
      '--review',
      'also run the adversarial reviewer and include its verdict as a check ' +
        '(optional locally; the shipped CI workflow always passes this)',
    )
    .action(async (change: string, opts: { diffBase?: string; review?: boolean }) => {
      const root = process.cwd();

      // Enforcement config: `--config-from` (the CI target-branch checkout) wins,
      // else the working tree (invariant 7). Missing/malformed → exit 2/3 from the
      // loader — verify is an enforcement command; it does not run without config.
      const configRoot = resolveEnforcementRoot(program.opts().configFrom, root);
      const config: EnforcementConfig = loadEnforcementConfig(configRoot);

      const report = await verify(
        { root, change, config },
        liveDeps(root, opts.diffBase, { change, withReview: opts.review === true }),
      );

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

      // A red verdict exits 1 (architecture.md §2) — a verdict, not an error. The
      // report is already printed; CheckFailure carries the exit code silently.
      if (report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** The live dependencies for a real verify invocation. */
function liveDeps(
  root: string,
  diffBase: string | undefined,
  reviewOpts: { change: string; withReview: boolean },
): VerifyDeps {
  return {
    resolve: liveAdapterUnavailable,
    run: liveAdapterUnavailable,
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
          resolve: liveAdapterUnavailable,
          runIn: liveAdapterUnavailable,
        },
      ),
    // The adversarial reviewer (design phase-2.md §5): the whole review-command
    // flow behind one edge — supplied only under `--review` (the shipped CI
    // workflow always passes it; locally it is opt-in). Model from convenience
    // `models.review` (invariant 11 — it shapes the session, never the gate).
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
              { substrate: new ClaudeCodeSubstrate(), now: () => new Date().toISOString() },
            ),
        }
      : {}),
  };
}

/**
 * The dry-run resolver and oracle runner both spawn the pinned adapter via the
 * P1-11 client, which `init` records in the project config (P2). Until that pin
 * exists, fail closed rather than run the checks against no adapter.
 */
const liveAdapterUnavailable = (): never => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves and runs oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then verify runs only via its injectable core (see the P1-16 tracer).',
  );
};

/**
 * Assemble the diff facts (touched paths + changed lines) from git — the tier's
 * observable inputs. The base is `--diff-base` (CI passes `origin/<base_ref>`),
 * else the merge-base of HEAD and origin/HEAD (design §2). In this enforcement
 * context an uncomputable diff is exit 3 (fail-closed, invariant 3) — never
 * "assume trivial": a change we cannot size is a change we cannot judge.
 */
function computeDiffFacts(root: string, diffBase: string | undefined): DiffFacts {
  const base = diffBase ?? defaultBase(root);
  const range = `${base}...HEAD`;

  const names = git(root, ['diff', '--name-only', range]);
  const touchedPaths = names
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // numstat rows: `<added>\t<deleted>\t<path>`; sum added + deleted. A binary
  // file shows `-\t-\t<path>` — treat `-` as 0 (no line delta to cap).
  const numstat = git(root, ['diff', '--numstat', range]);
  let diffLines = 0;
  for (const line of numstat.split('\n')) {
    if (line.trim().length === 0) continue;
    const [added, deleted] = line.split('\t');
    diffLines += toCount(added) + toCount(deleted);
  }

  return { touchedPaths, diffLines };
}

/** The default diff base: merge-base of HEAD and origin/HEAD. Uncomputable → exit 3. */
function defaultBase(root: string): string {
  return git(root, ['merge-base', 'HEAD', 'origin/HEAD']).trim();
}

/** `-` (binary) → 0; otherwise the parsed integer line count. */
function toCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Run a git command in `root`, returning stdout. Unlike status's best-effort git
 * edge, a failure here is fail-closed exit 3 (invariant 3): verify is enforcement,
 * and a diff it cannot compute must not be silently downgraded to trivial.
 */
function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (cause) {
    throw invalidInputError(
      'DIFF_UNCOMPUTABLE',
      `Could not compute the diff for tier enforcement (git ${args.join(' ')} failed): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      'Ensure the repo has full history (CI checks out with fetch-depth: 0) and the ' +
        'diff base is fetched, or pass an explicit --diff-base <ref>.',
    );
  }
}
