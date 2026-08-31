import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P4R-02: the active-session wrappers no longer execute adapters or launch
// agents. `verify` is the remaining ordinary CLI path that executes oracle
// targets, so it alone must use the hash-verifying lockfile runtime.

const CORE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const COMMANDS = ['verify.cli.ts'] as const;

describe('pinned adapter runtime wiring', () => {
  it.each(COMMANDS)('%s loads the shared pinned-adapter client', (file) => {
    const source = readFileSync(join(CORE_SRC, 'commands', file), 'utf8');

    expect(source).toContain("from '../adapters/runtime.js'");
    expect(source).toContain('loadPinnedAdapterClient(root');
    expect(source).not.toContain('NO_ADAPTER_PIN');
  });

  it.each(['verify.cli.ts'])(
    '%s roots merge-base reproduction runs in the temporary worktree',
    (file) => {
      const source = readFileSync(join(CORE_SRC, 'commands', file), 'utf8');
      expect(source).toContain('loadPinnedAdapterClient(root, worktreePath)');
    },
  );
});
