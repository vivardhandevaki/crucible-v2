// P3-06/charter acceptance — when a project has an adapter lockfile, every new
// approval seals it alongside the artifacts and bound tests. A mid-change pin
// edit must therefore void approval instead of changing the judges silently.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTER_LOCK_RELPATH } from '../adapters/lockfile.js';
import { computeHashScope } from './bundle.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-lock-seal-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('computeHashScope — adapter lock', () => {
  it('includes the committed adapter lockfile whenever it exists', async () => {
    mkdirSync(join(root, '.crucible'), { recursive: true });
    writeFileSync(join(root, ADAPTER_LOCK_RELPATH), 'version: 1\nadapters: {}\n', 'utf8');
    const changeRel = 'openspec/changes/example';
    const scope = await computeHashScope(
      root,
      changeRel,
      join(root, changeRel),
      [],
      async () => [],
    );
    expect(scope).toContain(ADAPTER_LOCK_RELPATH);
  });
});
