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
// guessing (contrast status's best-effort git edge, P1-14).

import { execFileSync } from 'node:child_process';
import type { DiffFacts } from './verify.js';
import { invalidInputError } from '../util/errors.js';

/**
 * Assemble the diff facts (touched paths + changed lines) from git — the tier's
 * observable inputs. The base is `--diff-base` (CI passes `origin/<base_ref>`),
 * else the merge-base of HEAD and origin/HEAD (design §2). An uncomputable diff
 * is exit 3 (fail-closed) — never "assume trivial".
 */
export function computeDiffFacts(root: string, diffBase: string | undefined): DiffFacts {
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
export function defaultBase(root: string): string {
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
 * edge, a failure here is fail-closed exit 3 (invariant 3): these are enforcement
 * commands, and a diff they cannot compute must not be silently downgraded to
 * trivial.
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
