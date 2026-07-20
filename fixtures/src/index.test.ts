import { describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from './index.js';

// Placeholder test proving the workspace toolchain is wired. The real fixture
// smoke test (loading fixtures/toy-repo) arrives with P0-03.
describe('@crucible/fixtures scaffold', () => {
  it('names the fixtures root', () => {
    expect(FIXTURES_ROOT).toBe('toy-repo');
  });
});
