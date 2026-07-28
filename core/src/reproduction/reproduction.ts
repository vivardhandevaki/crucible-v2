// Reproduction runner — the merge-base worktree run behind a bugfix's
// red-on-base/green-on-fix check (charter §Change Types L251; design phase-2.md
// §4, task P2-08). A bugfix's reproduction oracle "must fail on the pre-fix
// commit and pass on the fix — CI-checked, no honor system." verify's ordinary
// oracle run already proves GREEN-ON-FIX (the reproduction oracles run against
// HEAD like any other); this module proves RED-ON-BASE by executing the SAME
// reproduction oracles against the merge-base source.
//
// Mechanism (as-built; the design fixed the check, not its plumbing): check out
// the merge-base into a THROWAWAY git worktree, carry the reproduction oracles'
// test files from the working tree onto that old source (the charter's "the new
// test on the pre-fix commit" — new test, old source), run the adapter with cwd
// pointed at the worktree, then ALWAYS tear the worktree down. Cleanup is proven
// even on throw (invariant 3): the worktree is scratch state, never left behind.
//
// Determinism (invariant 12): the git edge (worktree add / overlay / remove) and
// the adapter edges (resolve for locating the test files, run for executing them)
// are all INJECTED — the core orchestration here spawns nothing, so it is
// hermetically testable. `liveWorktreeGit` is the real git-spawning edge the CLI
// wires in, mirroring how verify.cli.ts supplies the live adapter client.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { dedupeTargets } from '../commands/bundle.js';
import { invalidInputError } from '../util/errors.js';

/**
 * The git worktree lifecycle, injected so the orchestration stays deterministic
 * and hermetically testable. `add` checks `ref` out into a fresh worktree at
 * `worktreePath`; `overlay` copies `relPaths` from `sourceRoot` (the working
 * tree) into the worktree so the NEW reproduction tests run against the OLD
 * source; `remove` tears the worktree down (best-effort — teardown must not mask
 * a real failure from the run).
 */
export interface WorktreeGit {
  add(worktreePath: string, ref: string): void;
  overlay(worktreePath: string, sourceRoot: string, relPaths: readonly string[]): void;
  remove(worktreePath: string): void;
}

/** The injected edges the reproduction run rests on (all non-deterministic). */
export interface ReproductionDeps {
  /** The git worktree lifecycle (real one: `liveWorktreeGit`). */
  git: WorktreeGit;
  /**
   * Locate the reproduction targets' test files (adapter `resolve`, against the
   * working tree) so `overlay` can carry them onto the pre-fix checkout.
   */
  resolve: ResolveFn;
  /** Run the reproduction oracles with `cwd` = the worktree (adapter `run`). */
  runIn: (worktreePath: string, oracles: readonly Oracle[]) => Promise<OracleResult[]>;
}

/** What the reproduction run needs: the repo root, the base ref, and the oracles. */
export interface ReproductionOptions {
  /** Repo root: the working tree the new test files are carried FROM. */
  root: string;
  /** The merge-base ref — the pre-fix checkout the reproduction must fail on. */
  base: string;
  /** The bugfix's reproduction oracles (already filtered to `reproduces: true`). */
  oracles: readonly Oracle[];
}

/**
 * Run the reproduction oracles against the merge-base checkout and return their
 * joined results (the RED-ON-BASE evidence `reproductionCheck` judges). An empty
 * oracle list short-circuits (nothing to reproduce). A reproduction target that
 * does not resolve to a test file is fail-closed exit 3 — a reproduction whose
 * test we cannot locate cannot be carried onto base (this is a backstop: verify's
 * lint gate runs first and would already have caught an unresolved binding).
 */
export async function runReproductionOnBase(
  options: ReproductionOptions,
  deps: ReproductionDeps,
): Promise<OracleResult[]> {
  const { root, base, oracles } = options;
  if (oracles.length === 0) return [];

  // Locate the reproduction test files (against the working tree) so they can be
  // carried onto the old source. Done BEFORE any worktree is created, so a
  // resolve failure never leaks a worktree.
  const targets = dedupeTargets(oracles);
  const resolutions = await deps.resolve(targets);
  const files = distinctTargetFiles(resolutions);

  const worktree = worktreePathFor(root, base);
  deps.git.add(worktree, base);
  try {
    // New test onto old source: overlay only the reproduction TEST files; the
    // fix's source stays at the base revision.
    if (files.length > 0) deps.git.overlay(worktree, root, files);
    return await deps.runIn(worktree, oracles);
  } finally {
    // Cleanup is proven even when the run above throws (invariant 3).
    deps.git.remove(worktree);
  }
}

/** Distinct resolved test files for the reproduction targets; unresolved → exit 3. */
function distinctTargetFiles(resolutions: readonly TargetResolution[]): string[] {
  const files = new Set<string>();
  for (const r of resolutions) {
    if (r.status !== 'found' || r.targetFile === undefined || r.targetFile.length === 0) {
      throw invalidInputError(
        'UNRESOLVED_REPRODUCTION_TARGET',
        `Cannot run the reproduction check: target ${r.target} did not resolve to a test file to carry onto the merge-base.`,
        'Ensure every `reproduces: true` oracle binds an addressable test (crucible propose --revise).',
      );
    }
    files.add(r.targetFile);
  }
  return [...files].sort();
}

/**
 * A deterministic worktree path under the repo's `.crucible/worktrees/`, keyed by
 * the base ref so repeated runs reuse one slot (a stale slot from a crashed run
 * is cleared by `liveWorktreeGit.add`). Kept inside the repo so it shares the
 * object store and needs no extra fetch.
 */
export function worktreePathFor(root: string, base: string): string {
  const tag = createHash('sha256').update(base).digest('hex').slice(0, 12);
  return join(root, '.crucible', 'worktrees', `repro-${tag}`);
}

/**
 * The real git-spawning worktree edge (the CLI wires this in). Every git failure
 * is fail-closed exit 3 (invariant 3) — a merge-base we cannot check out is a
 * reproduction we cannot judge. `remove` is deliberately tolerant: a teardown
 * hiccup must not mask the run's own verdict, and a raw directory delete + prune
 * is the fallback so no scratch worktree is ever left behind.
 */
export function liveWorktreeGit(repoRoot: string): WorktreeGit {
  const git = (args: readonly string[], cwd = repoRoot): void => {
    try {
      execFileSync('git', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (cause) {
      throw invalidInputError(
        'WORKTREE_FAILED',
        `Reproduction worktree step failed (git ${args.join(' ')}): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        'Ensure the repo has full history (CI checks out with fetch-depth: 0) so the merge-base is present.',
      );
    }
  };
  return {
    add(worktreePath, ref) {
      // A stale worktree from a crashed run must not block a fresh one.
      if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
      git(['worktree', 'prune']);
      git(['worktree', 'add', '--force', '--detach', worktreePath, ref]);
    },
    overlay(worktreePath, sourceRoot, relPaths) {
      for (const rel of relPaths) {
        const to = join(worktreePath, rel);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(join(sourceRoot, rel), to);
      }
    },
    remove(worktreePath) {
      try {
        git(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Fall back to a raw delete + prune so a half-registered worktree still goes.
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          git(['worktree', 'prune']);
        } catch {
          /* nothing more we can do; the scratch dir is already gone. */
        }
      }
    },
  };
}
