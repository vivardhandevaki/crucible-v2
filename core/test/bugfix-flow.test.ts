import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_ADAPTER_BIN_PATH, STUB_ADAPTER_MANIFEST_PATH } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterClient } from '../src/adapters/client.js';
import { loadManifest } from '../src/adapters/manifest.js';
import type { Oracle } from '../src/artifacts/oracles.js';
import {
  liveWorktreeGit,
  runReproductionOnBase,
  worktreePathFor,
} from '../src/reproduction/reproduction.js';
import { verify } from '../src/commands/verify.js';

// ─── P2-08: bugfix red-on-base / green-on-fix — REAL git + REAL stub adapter ──
//
// The permanent proof that the merge-base worktree run works end to end. ONLY
// the change bundle is authored inline; the adapter path is real (the P1-11
// client spawns the built stub against each cwd's tests.json), the git worktree
// is a real `git worktree add/remove` against a real two-commit repo, and the
// reproduction verdict is the production `verify` core.
//
// The scenario models a bug + its fix: the reproduction target FAILS at the base
// commit (bug present) and PASSES at the fix commit (bug gone). Because the stub
// is declarative, "fails on the pre-fix source" is expressed as the base commit's
// tests.json declaring the reproduction target `fail`; the fix commit declares it
// `pass`. The worktree checkout of the base therefore reads the base declaration,
// exactly as a real adapter would run the carried-over test against old source.

const CHANGE = 'fix-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const REPRO_TARGET = 'greeting::repro_nullbyte';
const REPRO_FILE = 'tests/repro.test.ts';

const manifest = loadManifest(STUB_ADAPTER_MANIFEST_PATH);

/** A P1-11 client bound to `cwd` (the working tree, or a base worktree). */
function client(cwd: string) {
  return createAdapterClient({
    manifest,
    cwd,
    resolveExecutable: (name) =>
      name === 'crucible-adapter-stub'
        ? { command: process.execPath, prefixArgs: [STUB_ADAPTER_BIN_PATH] }
        : { command: name, prefixArgs: [] },
    extraArgs: ['--tests', 'tests.json'],
    timeoutMs: 10_000,
  });
}

const BUGFIX_SPEC = `# greeting

## ADDED Requirements

### Requirement: Greeting strips null bytes [REQ-greeting-nullbyte-9]

The system SHALL strip embedded null bytes before greeting.

#### Scenario: A name contains a null byte

- **WHEN** \`greet("a\\u0000b")\` is called
- **THEN** it returns \`Hello, ab!\`
`;

const BUGFIX_ORACLES = `# Oracles — fix-greeting

## ORC-greeting-repro-001: Null byte is stripped (reproduction)
**Given** a name with an embedded null byte
**When** \`greet(name)\` is called
**Then** the null byte is stripped

\`\`\`yaml crucible-binding
requirement: REQ-greeting-nullbyte-9
kind: unit
runner: stub
target: ${REPRO_TARGET}
reproduces: true
\`\`\`
`;

/** tests.json declaring the reproduction target with the given base/head status. */
function testsJson(reproStatus: 'pass' | 'fail'): string {
  return JSON.stringify([{ id: REPRO_TARGET, file: REPRO_FILE, status: reproStatus }], null, 2);
}

let repo: string;
let baseSha: string;

/** Run a git command in the temp repo (test scaffolding). */
function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Build a two-commit repo. Base commit: old source + tests.json declaring the
 * reproduction target `baseReproStatus`. Fix commit (HEAD, the working tree): the
 * change bundle, the new reproduction test file, and tests.json declaring the
 * reproduction target `pass` (green on fix).
 */
function buildRepo(baseReproStatus: 'pass' | 'fail'): void {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  writeFileSync(join(repo, 'src.txt'), 'buggy\n');
  writeFileSync(join(repo, 'tests.json'), testsJson(baseReproStatus));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base (pre-fix)']);
  baseSha = git(['rev-parse', 'HEAD']).trim();

  // The fix commit: the bundle, the new reproduction test, and green tests.json.
  const specDir = join(repo, CHANGE_REL, 'specs', 'greeting');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(repo, CHANGE_REL, '.openspec.yaml'), 'schema: crucible-bugfix\n');
  writeFileSync(join(repo, CHANGE_REL, 'oracles.md'), BUGFIX_ORACLES);
  writeFileSync(join(specDir, 'spec.md'), BUGFIX_SPEC);
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, REPRO_FILE), '// the new reproduction test\n');
  writeFileSync(join(repo, 'src.txt'), 'fixed\n');
  writeFileSync(join(repo, 'tests.json'), testsJson('pass'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fix + reproduction oracle']);
}

/** verify deps wired to the REAL stub adapter + REAL git worktree edge. */
function realDeps() {
  const root = client(repo);
  return {
    resolve: (targets: readonly string[]) => root.resolve(targets),
    run: (oracles: readonly Oracle[]) => root.run(oracles),
    runOnBase: (oracles: readonly Oracle[]) =>
      runReproductionOnBase(
        { root: repo, base: baseSha, oracles },
        {
          git: liveWorktreeGit(repo),
          resolve: (targets) => root.resolve(targets),
          runIn: (wt, orcs) => client(wt).run(orcs),
        },
      ),
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crucible-bugfix-'));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('bugfix red-on-base / green-on-fix (real git + real stub adapter)', () => {
  it('reproduction fails on base, passes on fix → the fixture bugfix passes (acceptance)', async () => {
    buildRepo('fail');
    const report = await verify({ root: repo, change: CHANGE }, realDeps());

    expect(report.verdict).toBe('pass');
    const repro = report.checks.find((c) => c.name === 'reproduction');
    expect(repro?.status).toBe('pass');
    // green-on-fix: the reproduction oracle passed against HEAD too.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('pass');

    // Worktree cleanup proven — on disk AND in git's registry (acceptance).
    const wt = worktreePathFor(repo, baseSha);
    expect(existsSync(wt)).toBe(false);
    expect(git(['worktree', 'list'])).not.toContain(wt);
  });

  it('reproduction passes on base → red "does not reproduce" (exit 1)', async () => {
    buildRepo('pass');
    const report = await verify({ root: repo, change: CHANGE }, realDeps());

    expect(report.verdict).toBe('fail');
    const repro = report.checks.find((c) => c.name === 'reproduction');
    expect(repro?.status).toBe('fail');
    expect(repro?.findings[0]?.id).toBe('ORC-greeting-repro-001');
    expect(repro?.findings[0]?.message).toContain('does not reproduce');

    // Even on the red path the worktree is torn down.
    expect(existsSync(worktreePathFor(repo, baseSha))).toBe(false);
  });
});
