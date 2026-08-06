// CLI wiring for `crucible review` — binds the deterministic core (`review`) to
// the real edges: the selected agent substrate, the wall clock, git (diff
// endpoints), and model routing from the convenience config. The core stays
// testable and reproducible (invariant 12); this file is the thin shim that
// supplies live dependencies and maps the outcome to the exit code.
//
// A reviewer FAIL (a block, or any fail-closed verdict defect) is a verdict,
// not an error: the report is rendered, then `CheckFailure` maps it to exit 1
// (architecture.md §2 — "checks ran and failed: reviewer block"). Genuine
// failures (no bundle, no role prompt, unusable rubric) throw `CrucibleError`
// (exit 2/3) from the core.
//
// Model routing is centralized in substrate/runtime.ts: provider defaults apply unless
// convenience config supplies an opaque models.review override. This shapes only
// the session (invariant 11); the verdict model field remains audit-grade.

import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import type { Command } from 'commander';
import { resolveAgentRuntime } from '../substrate/runtime.js';
import { review } from './review.js';
import { aggregate, renderReport } from '../verifyx/report.js';
import { appendStateEvent } from '../state/state.js';
import { CheckFailure, invalidInputError } from '../util/errors.js';

/** Register the real `review` subcommand on the program. */
export function registerReview(program: Command): void {
  program
    .command('review')
    .description('Run the adversarial reviewer against the change diff and rubric')
    .argument('<change>', 'the change name to review (openspec/changes/<change>/)')
    .option(
      '--diff-base <ref>',
      'the git ref the reviewed diff starts from ' +
        '(CI passes origin/<base_ref>; default: merge-base of HEAD and origin/HEAD)',
    )
    .action(async (change: string, opts: { diffBase?: string }) => {
      const root = process.cwd();
      const result = await review(
        {
          root,
          change,
          model: reviewModel(root),
          base: opts.diffBase ?? mergeBase(root),
          head: gitHead(root),
        },
        {
          substrate: resolveAgentRuntime(root, 'review').substrate,
          now: () => new Date().toISOString(),
        },
      );

      // One check, one report — the same zod-guarded verdict surface every
      // judging command uses (verifyx/report.ts).
      const report = aggregate(change, [result.check], { review: result.review });

      // Best-effort audit event (invariant 1: derived trail, never enforcement;
      // invariant 11: its failure must not affect the verdict).
      try {
        appendStateEvent(
          join(root, 'openspec', 'changes', change, 'state.yaml'),
          change,
          {
            at: new Date().toISOString(),
            cmd: 'review',
            summary: `review ${report.verdict} (rubric ${result.rubricHash.slice(0, 12)})`,
            transcript: relative(root, result.transcriptPath),
            execution_mode: 'headless',
          },
          report.verdict === 'pass' ? 'reviewed' : 'review-red',
        );
      } catch {
        /* convenience-never-enforcement: a failed audit write is silent. */
      }

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        process.stdout.write(renderReport(report, 'review') + '\n');
        process.stdout.write(`Verdict: ${result.verdictPath}\n`);
        process.stdout.write(`Transcript: ${result.transcriptPath}\n`);
      }

      // A reviewer fail exits 1 — a verdict, not an error (architecture.md §2).
      if (report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** Model routing: convenience `models.review`, else the cheap different-family
 * default (invariant 11 — convenience shapes a session, never enforcement). */
export function reviewModel(root: string): string {
  return resolveAgentRuntime(root, 'review').model;
}

/** The default diff base: merge-base of HEAD and origin/HEAD. Uncomputable → exit 3. */
export function mergeBase(root: string): string {
  return git(root, ['merge-base', 'HEAD', 'origin/HEAD']).trim();
}

/** The reviewed head sha (recorded in the verdict as `reviewed_sha`, audit). */
export function gitHead(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/**
 * Run a git command in `root`, returning stdout. Fail-closed exit 3 (invariant
 * 3): review is an enforcement input, and a diff we cannot anchor is a review
 * we cannot adjudicate — never silently reviewed against the wrong base.
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
      `Could not resolve the review diff endpoints (git ${args.join(' ')} failed): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      'Ensure the repo has history and origin/HEAD is fetched, or pass an explicit --diff-base <ref>.',
    );
  }
}
