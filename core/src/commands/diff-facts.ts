// The git diff-facts edge shared by the enforcement commands (`verify` P2-03,
// `approve` P2-14) — design phase-2.md §2.
//
// Tier computation is PURE (invariant 12): it takes facts, not a repo. This
// module is the impure half — it shells to git to assemble those facts (touched
// paths + changed-line count vs a base ref) so the caller can hand them to the
// pure `computeTier`. It lives apart from any one command because BOTH the verify
// and approve CLIs are authoritative recomputation points and must assemble the
// facts identically (design §2 names propose/approve/implement/CI as the
// recomputation points; a drift between two of them would be a tier bug).
//
// In an enforcement context an uncomputable diff is exit 3 (fail-closed,
// invariant 3) — NEVER "assume trivial": a change we cannot size is a change we
// cannot judge. The `git` helper below throws `DIFF_UNCOMPUTABLE` rather than
// guessing (contrast status best-effort git edge, P1-14).

import { execFileSync } from 'node:child_process';
import type { DiffFacts } from './verify.js';
import { invalidInputError } from '../util/errors.js';

/**
 * Assemble the diff facts (touched paths + changed lines) from git — the tier
 * observable inputs. The base is `--diff-base` (CI passes `origin/<base_ref>`),
 * else the merge-base of HEAD and origin/HEAD (design §2). An uncomputable diff
 * is exit 3 (fail-closed) — never "assume trivial".
 */
export function computeDiffFacts(root: string, diffBase: string | undefined): DiffFacts {
  const base = diffBase ?? defaultBase(root);
  const range = `${base}...HEAD`;

  const rawTouchedPaths = parseNameOnly(git(root, ['diff', '--name-only', '-z', range]));
  const numstat = parseNumstatRecords(git(root, ['diff', '--numstat', '-z', range]));
  const numstatPaths = new Set(numstat.flatMap((record) => record.paths));
  for (const path of rawTouchedPaths) {
    if (!numstatPaths.has(path)) {
      throw malformedDiffFacts('name-only path has no numstat record: ' + path);
    }
  }
  const touchedPaths = rawTouchedPaths.filter((path) => !isDerivedStatePath(path));

  const diffLines = numstat
    .filter((record) => !record.paths.every(isDerivedStatePath))
    .reduce((total, record) => total + record.added + record.deleted, 0);

  return { touchedPaths, diffLines };
}

/** The default diff base: merge-base of HEAD and origin/HEAD. Uncomputable → exit 3. */
export function defaultBase(root: string): string {
  return git(root, ['merge-base', 'HEAD', 'origin/HEAD']).trim();
}

/** One NUL-delimited `git diff --numstat -z` record. */
export interface NumstatRecord {
  added: number;
  deleted: number;
  /** One ordinary path, or old/new paths for a rename/copy record. */
  paths: readonly string[];
}

/**
 * Exact derived cache paths, never enforcement facts (charter P4-22). The
 * matcher is deliberately structural: no glob, configuration, traversal, or
 * lookalike path can opt itself out of tiering.
 */
export function isDerivedStatePath(path: string): boolean {
  const parts = path.split('/');
  const normal = (value: string | undefined): value is string =>
    value !== undefined &&
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !/[\\\r\n]/.test(value);

  return (
    (parts.length === 4 &&
      parts[0] === 'openspec' &&
      parts[1] === 'changes' &&
      normal(parts[2]) &&
      parts[3] === 'state.yaml') ||
    (parts.length === 5 &&
      parts[0] === 'openspec' &&
      parts[1] === 'changes' &&
      parts[2] === 'archive' &&
      normal(parts[3]) &&
      parts[4] === 'state.yaml')
  );
}

/** Parse NUL-delimited `git diff --name-only -z` output without lossy quoting. */
function parseNameOnly(raw: string): string[] {
  if (raw.length === 0) return [];
  if (!raw.endsWith('\0')) {
    throw malformedDiffFacts('name-only output is not NUL terminated');
  }

  const paths = raw.slice(0, -1).split('\0');
  if (paths.some((path) => path.length === 0)) {
    throw malformedDiffFacts('name-only output contains an empty path');
  }
  return paths;
}

/**
 * Parse NUL-delimited `git diff --numstat -z` output. Renames/copies encode an
 * empty header path followed by old and new NUL-delimited paths; preserving both
 * lets a derived-to-derived rename remain derived while every mixed rename is
 * conservatively counted.
 */
export function parseNumstatRecords(raw: string): NumstatRecord[] {
  if (raw.length === 0) return [];
  if (!raw.endsWith('\0')) {
    throw malformedDiffFacts('numstat output is not NUL terminated');
  }

  const fields = raw.slice(0, -1).split('\0');
  const records: NumstatRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]!;
    const firstTab = header.indexOf('\t');
    const secondTab = header.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw malformedDiffFacts(`invalid numstat header ${JSON.stringify(header)}`);
    }

    const added = parseCount(header.slice(0, firstTab));
    const deleted = parseCount(header.slice(firstTab + 1, secondTab));
    const path = header.slice(secondTab + 1);
    if (path.length > 0) {
      records.push({ added, deleted, paths: [path] });
      continue;
    }

    const oldPath = fields[++index];
    const newPath = fields[++index];
    if (
      oldPath === undefined ||
      newPath === undefined ||
      oldPath.length === 0 ||
      newPath.length === 0
    ) {
      throw malformedDiffFacts('rename/copy numstat record is missing a path');
    }
    records.push({ added, deleted, paths: [oldPath, newPath] });
  }
  return records;
}

/** Binary `-/-` remains zero; every other count must be a safe non-negative integer. */
function parseCount(value: string): number {
  if (value === '-') return 0;
  if (!/^\d+$/.test(value)) {
    throw malformedDiffFacts(`invalid numstat line count ${JSON.stringify(value)}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw malformedDiffFacts(`unsafe numstat line count ${JSON.stringify(value)}`);
  }
  return count;
}

function malformedDiffFacts(detail: string) {
  return invalidInputError(
    'DIFF_UNCOMPUTABLE',
    `Could not compute the diff for tier enforcement: ${detail}.`,
    'Ensure git produced complete diff facts and retry from a repository with full history.',
  );
}

/**
 * Run a git command in `root`, returning stdout. Unlike status best-effort git
 * edge, a failure here is fail-closed exit 3: these are enforcement commands,
 * and a diff they cannot compute must not be silently downgraded to trivial.
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
