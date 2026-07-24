import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

// Placeholder test proving the workspace's toolchain (TS strict + vitest) is
// wired. Real TCB coverage (hash, lint, tier, parsers, adapter client) arrives
// with those modules in Phase 1 — see architecture.md §9.
describe('@crucible/core scaffold', () => {
  it('exposes its package marker', () => {
    expect(CORE_PACKAGE).toBe('@crucible/core');
  });
});
