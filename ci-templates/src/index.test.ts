import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_FILE } from './index.js';

// Placeholder test proving the workspace toolchain is wired. The real template
// validation (target-branch enforcement) arrives with P1-15.
describe('@crucible/ci-templates scaffold', () => {
  it('names the reusable workflow file', () => {
    expect(CI_TEMPLATE_FILE).toBe('crucible.yml');
  });
});
