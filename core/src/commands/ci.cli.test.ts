import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readChangedPaths } from './ci.cli.js';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('readChangedPaths — CI NUL transport', () => {
  it('preserves a NUL-delimited Git path list exactly', () => {
    root = mkdtempSync(join(tmpdir(), 'crucible-ci-paths-'));
    const path = join(root, 'paths.bin');
    writeFileSync(path, Buffer.from('src/a.ts\0openspec/changes/add-greeting/design.md\0'));

    expect(readChangedPaths(path)).toEqual(['src/a.ts', 'openspec/changes/add-greeting/design.md']);
  });

  it('fails closed for empty or non-NUL-terminated transport', () => {
    root = mkdtempSync(join(tmpdir(), 'crucible-ci-paths-'));
    const empty = join(root, 'empty.bin');
    const malformed = join(root, 'malformed.bin');
    writeFileSync(empty, Buffer.alloc(0));
    writeFileSync(malformed, 'src/a.ts');

    expect(() => readChangedPaths(empty)).toThrow(/NUL terminated/i);
    expect(() => readChangedPaths(malformed)).toThrow(/NUL terminated/i);
  });
});
