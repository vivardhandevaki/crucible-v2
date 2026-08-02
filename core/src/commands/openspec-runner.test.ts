import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openspecExecutable } from './openspec-runner.js';

describe('OpenSpec runtime runner', () => {
  it('resolves the exact CLI packaged with Crucible instead of a consumer-project npx lookup', () => {
    const executable = openspecExecutable();

    expect(executable).toMatch(/node_modules\/@fission-ai\/openspec\/bin\/openspec\.js$/);
    expect(existsSync(executable)).toBe(true);
    expect(readFileSync(executable, 'utf8')).toContain('runCli');
  });

  it('scaffolds a change from a consumer directory with no npm project', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const scratch = mkdtempSync(join(tmpdir(), 'crucible-openspec-runner-'));
    try {
      mkdirSync(join(scratch, 'openspec'), { recursive: true });
      cpSync(
        join(repoRoot, 'schemas', 'crucible'),
        join(scratch, 'openspec', 'schemas', 'crucible'),
        {
          recursive: true,
        },
      );
      writeFileSync(join(scratch, 'openspec', 'config.yaml'), 'schema: crucible\n');

      const result = spawnSync(
        process.execPath,
        [openspecExecutable(), 'new', 'change', 'add-list-notes', '--schema', 'crucible', '--json'],
        { cwd: scratch, encoding: 'utf8' },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(
        existsSync(join(scratch, 'openspec', 'changes', 'add-list-notes', '.openspec.yaml')),
      ).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
