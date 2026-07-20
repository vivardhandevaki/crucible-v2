import { describe, expect, it } from 'vitest';
import { ADAPTER_ID } from './index.js';

// Placeholder test proving the workspace toolchain is wired. The adapter's
// wire-protocol conformance tests seed fixtures/conformance/ in P1-10.
describe('@crucible/adapter-stub scaffold', () => {
  it('reports its adapter id', () => {
    expect(ADAPTER_ID).toBe('stub');
  });
});
