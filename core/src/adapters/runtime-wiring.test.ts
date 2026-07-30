import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P3-08 acceptance: every live role/enforcement path must use the same
// hash-verifying lockfile runtime. Keeping this source-level dependency test
// beside the runtime prevents a future command from restoring a fail-closed
// placeholder or spawning an unpinned judge through a parallel seam.

const CORE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const COMMANDS = [
  'propose.cli.ts',
  'approve.cli.ts',
  'amend.cli.ts',
  'implement.cli.ts',
  'verify.cli.ts',
  'why.cli.ts',
] as const;

describe('pinned adapter runtime wiring', () => {
  it.each(COMMANDS)('%s loads the shared pinned-adapter client', (file) => {
    const source = readFileSync(join(CORE_SRC, 'commands', file), 'utf8');

    expect(source).toContain("from '../adapters/runtime.js'");
    expect(source).toContain('loadPinnedAdapterClient(root');
    expect(source).not.toContain('NO_ADAPTER_PIN');
  });

  it.each(['verify.cli.ts', 'why.cli.ts'])(
    '%s roots merge-base reproduction runs in the temporary worktree',
    (file) => {
      const source = readFileSync(join(CORE_SRC, 'commands', file), 'utf8');
      expect(source).toContain('loadPinnedAdapterClient(root, worktreePath)');
    },
  );
});
