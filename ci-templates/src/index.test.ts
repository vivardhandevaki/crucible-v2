import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_FILE, CI_TEMPLATE_PATH } from './index.js';

// The workspace exposes the reusable workflow by name + path; its invariant-#7
// structure is validated in crucible-template.test.ts.
describe('@crucible/ci-templates surface', () => {
  it('names the reusable workflow file', () => {
    expect(CI_TEMPLATE_FILE).toBe('crucible.yml');
  });

  it('resolves the workflow to a file that exists', () => {
    expect(CI_TEMPLATE_PATH.endsWith('crucible.yml')).toBe(true);
    expect(existsSync(CI_TEMPLATE_PATH)).toBe(true);
  });
});
