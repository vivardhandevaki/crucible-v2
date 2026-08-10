import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDiffFacts, isDerivedStatePath, parseNumstatRecords } from './diff-facts.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repository(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'crucible-diff-facts-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']).trim() };
}

describe('P4-22 derived state classifier', () => {
  it.each([
    'openspec/changes/create-note/state.yaml',
    'openspec/changes/archive/2026-08-10-create-note/state.yaml',
  ])('accepts exact derived state path %s', (path) => {
    expect(isDerivedStatePath(path)).toBe(true);
  });

  it.each([
    'openspec/changes/state.yaml',
    'openspec/changes/create-note/specs/notes/state.yaml',
    'openspec/changes/create-note/state.yml',
    'openspec/changes/create-note/State.yaml',
    'openspec/changes/../state.yaml',
    '/openspec/changes/create-note/state.yaml',
    'src/state.yaml',
  ])('does not exempt lookalike path %s', (path) => {
    expect(isDerivedStatePath(path)).toBe(false);
  });
});

describe('P4-22 numstat parsing', () => {
  it('preserves binary zero counts and rejects malformed non-binary rows', () => {
    expect(parseNumstatRecords('-\t-\tassets/logo.png\0')).toEqual([
      { added: 0, deleted: 0, paths: ['assets/logo.png'] },
    ]);
    expect(() => parseNumstatRecords('1\tnot-a-number\tsrc/app.ts\0')).toThrow(
      /Could not compute the diff for tier enforcement/,
    );
    expect(() => parseNumstatRecords('1\t2\0')).toThrow(
      /Could not compute the diff for tier enforcement/,
    );
  });
});

describe('P4-22 effective git diff facts', () => {
  it('returns zero facts for a committed state-only change', () => {
    const { root, base } = repository();
    mkdirSync(join(root, 'openspec', 'changes', 'create-note'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'create-note', 'state.yaml'), 'events: []\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'record audit']);

    expect(computeDiffFacts(root, base)).toEqual({ touchedPaths: [], diffLines: 0 });
  });

  it('counts non-state bytes exactly while excluding the adjacent state event', () => {
    const { root, base } = repository();
    mkdirSync(join(root, 'openspec', 'changes', 'create-note'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'create-note', 'state.yaml'), 'events: []\n');
    writeFileSync(join(root, 'src', 'note.ts'), 'export const note = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'feature and audit']);

    expect(computeDiffFacts(root, base)).toEqual({
      touchedPaths: ['src/note.ts'],
      diffLines: 1,
    });
  });
});

describe('P4-22 additional enforcement coverage', () => {
  it('preserves both paths for a rename/copy numstat record', () => {
    expect(
      parseNumstatRecords(
        '1\t1\t\0openspec/changes/create-note/state.yaml\0openspec/changes/archive/2026-08-10-create-note/state.yaml\0',
      ),
    ).toEqual([
      {
        added: 1,
        deleted: 1,
        paths: [
          'openspec/changes/create-note/state.yaml',
          'openspec/changes/archive/2026-08-10-create-note/state.yaml',
        ],
      },
    ]);
  });

  it('returns zero facts when a committed derived state file is deleted', () => {
    const { root } = repository();
    mkdirSync(join(root, 'openspec', 'changes', 'create-note'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'create-note', 'state.yaml'), 'events: []\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'record audit']);
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['rm', '-q', 'openspec/changes/create-note/state.yaml']);
    git(root, ['commit', '-qm', 'remove derived audit']);

    expect(computeDiffFacts(root, base)).toEqual({ touchedPaths: [], diffLines: 0 });
  });

  it('counts a nested state lookalike as an ordinary enforcement path', () => {
    const { root, base } = repository();
    mkdirSync(join(root, 'openspec', 'changes', 'create-note', 'specs', 'notes'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'openspec', 'changes', 'create-note', 'specs', 'notes', 'state.yaml'),
      'must count\n',
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'lookalike']);

    expect(computeDiffFacts(root, base)).toEqual({
      touchedPaths: ['openspec/changes/create-note/specs/notes/state.yaml'],
      diffLines: 1,
    });
  });
});
