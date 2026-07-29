import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import {
  liveWorktreeGit,
  runReproductionOnBase,
  worktreePathFor,
  type WorktreeGit,
} from './reproduction.js';

// P2-08: the merge-base worktree run behind a bugfix's red-on-base check. The
// orchestration is hermetically testable (all edges injected); the git edge is
// exercised for real against a temp repo so worktree CLEANUP is proven — even
// when the run throws (invariant 3: the worktree is scratch, never left behind).

/** A reproduction oracle bound to one target (the shape the runner consumes). */
function reproOracle(id: string, target: string): Oracle {
  return {
    id,
    title: 'repro',
    heading: `## ${id}: repro`,
    line: 1,
    sectionEnd: 1,
    prose: `## ${id}: repro`,
    binding: {
      requirement: 'REQ-bug-1',
      kind: 'unit',
      runner: 'stub',
      targets: [target],
      reproduces: true,
    },
  };
}

/** A resolver mapping each target to a fixed file (so overlay has something to carry). */
const resolveToFile =
  (file: string): ResolveFn =>
  (targets) =>
    Promise.resolve(
      targets.map((t): TargetResolution => ({ target: t, status: 'found', targetFile: file })),
    );

describe('runReproductionOnBase — orchestration (injected edges)', () => {
  /** A spy WorktreeGit recording the lifecycle calls in order. */
  function spyGit(): { git: WorktreeGit; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      git: {
        add: (wt, ref) => calls.push(`add ${ref}`),
        overlay: (wt, root, paths) => calls.push(`overlay ${[...paths].join(',')}`),
        remove: () => calls.push('remove'),
      },
    };
  }

  it('adds the base worktree, overlays the resolved test files, runs, then removes', async () => {
    const { git, calls } = spyGit();
    const results = await runReproductionOnBase(
      { root: '/repo', base: 'abc123', oracles: [reproOracle('ORC-bug-001', 'bug::repro')] },
      {
        git,
        resolve: resolveToFile('tests/bug.test.ts'),
        runIn: (_wt, oracles) =>
          Promise.resolve(
            oracles.map((o): OracleResult => ({
              oracleId: o.id,
              requirement: o.binding.requirement,
              status: 'fail',
              targets: [{ target: 'bug::repro', status: 'fail' }],
            })),
          ),
      },
    );
    expect(results[0]?.status).toBe('fail');
    // Lifecycle order: add → overlay → (run) → remove.
    expect(calls).toEqual(['add abc123', 'overlay tests/bug.test.ts', 'remove']);
  });

  it('removes the worktree even when the run THROWS (cleanup proven on throw)', async () => {
    const { git, calls } = spyGit();
    await expect(
      runReproductionOnBase(
        { root: '/repo', base: 'abc123', oracles: [reproOracle('ORC-bug-001', 'bug::repro')] },
        {
          git,
          resolve: resolveToFile('tests/bug.test.ts'),
          runIn: () => Promise.reject(new Error('adapter blew up')),
        },
      ),
    ).rejects.toThrow('adapter blew up');
    // The failing run did not skip teardown.
    expect(calls).toContain('remove');
    expect(calls).toEqual(['add abc123', 'overlay tests/bug.test.ts', 'remove']);
  });

  it('an empty oracle batch short-circuits — no worktree is even created', async () => {
    const { git, calls } = spyGit();
    const results = await runReproductionOnBase(
      { root: '/repo', base: 'abc123', oracles: [] },
      {
        git,
        resolve: resolveToFile('tests/bug.test.ts'),
        runIn: () => Promise.reject(new Error('unreached')),
      },
    );
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a reproduction target that does not resolve to a file is fail-closed exit 3 (before any worktree)', async () => {
    const { git, calls } = spyGit();
    const unresolved: ResolveFn = (targets) =>
      Promise.resolve(targets.map((t): TargetResolution => ({ target: t, status: 'missing' })));
    let caught: unknown;
    try {
      await runReproductionOnBase(
        { root: '/repo', base: 'abc123', oracles: [reproOracle('ORC-bug-001', 'bug::repro')] },
        { git, resolve: unresolved, runIn: () => Promise.reject(new Error('unreached')) },
      );
    } catch (err) {
      caught = err;
    }
    expect(isCrucibleError(caught) && caught.exit).toBe(3);
    // No worktree was created, so none needs removing.
    expect(calls).toEqual([]);
  });
});

describe('liveWorktreeGit — real git worktree lifecycle', () => {
  let repo: string;

  /** Run a git command in the temp repo (test scaffolding, not under test). */
  function git(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'crucible-repro-git-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    // Base commit: old source, no reproduction test.
    writeFileSync(join(repo, 'src.txt'), 'buggy\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('adds a worktree at the base ref, overlays a working-tree file, and removes it cleanly', () => {
    const base = git(['rev-parse', 'HEAD']).trim();
    // The "fix": new source + a new reproduction test in the WORKING TREE (uncommitted).
    writeFileSync(join(repo, 'src.txt'), 'fixed\n');
    writeFileSync(join(repo, 'repro.test.txt'), 'the new reproduction test\n');

    const wt = worktreePathFor(repo, base);
    const edge = liveWorktreeGit(repo);
    edge.add(wt, base);
    try {
      expect(existsSync(wt)).toBe(true);
      // Base source is checked out (old bytes), NOT the working-tree fix.
      expect(readFileSync(join(wt, 'src.txt'), 'utf8')).toBe('buggy\n');
      // Overlay carries the NEW test (from the working tree) onto the old source.
      edge.overlay(wt, repo, ['repro.test.txt']);
      expect(readFileSync(join(wt, 'repro.test.txt'), 'utf8')).toBe('the new reproduction test\n');
      // Old source is untouched by the overlay — new test, old source.
      expect(readFileSync(join(wt, 'src.txt'), 'utf8')).toBe('buggy\n');
    } finally {
      edge.remove(wt);
    }
    // Cleanup proven on disk AND in git's worktree registry.
    expect(existsSync(wt)).toBe(false);
    expect(git(['worktree', 'list'])).not.toContain(wt);
  });

  it('add clears a stale worktree directory left by a crashed run', () => {
    const base = git(['rev-parse', 'HEAD']).trim();
    const wt = worktreePathFor(repo, base);
    const edge = liveWorktreeGit(repo);
    // Simulate a leftover from a crash: the target dir already exists.
    writeFileSync(join(repo, 'src.txt'), 'x\n');
    edge.add(wt, base);
    edge.remove(wt);
    // A second add over a (now-removed) slot must succeed, not collide.
    expect(() => {
      edge.add(wt, base);
      edge.remove(wt);
    }).not.toThrow();
    expect(existsSync(wt)).toBe(false);
  });
});
