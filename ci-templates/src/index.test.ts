import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CI_TEMPLATE_FILE,
  CI_TEMPLATE_PATH,
  JAVA_JUNIT_CI_TEMPLATE_FILE,
  JAVA_JUNIT_CI_TEMPLATE_PATH,
  ciTemplatePathForAdapter,
  renderCiTemplateForAdapter,
  renderAuthorityTransitionTemplateForAdapter,
} from './index.js';

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

  it('exposes a distinct java-junit workflow selected only for that adapter', () => {
    expect(JAVA_JUNIT_CI_TEMPLATE_FILE).toBe('crucible-java-junit.yml');
    expect(JAVA_JUNIT_CI_TEMPLATE_PATH.endsWith(JAVA_JUNIT_CI_TEMPLATE_FILE)).toBe(true);
    expect(existsSync(JAVA_JUNIT_CI_TEMPLATE_PATH)).toBe(true);
    expect(ciTemplatePathForAdapter('java-junit')).toBe(JAVA_JUNIT_CI_TEMPLATE_PATH);
    expect(ciTemplatePathForAdapter('stub')).toBe(CI_TEMPLATE_PATH);
  });

  it('renders an explicit dual-trigger authority bridge before the final target-owned workflow', () => {
    const transition = renderAuthorityTransitionTemplateForAdapter('stub', 'required');
    expect(transition).toContain('  pull_request:\n  pull_request_target:');
    expect(transition).toContain('  verify:');
    expect(renderCiTemplateForAdapter('stub', 'required')).not.toContain('  pull_request:\n');
  });

  it('selects a route-free JVM workflow when independent human review is advisory', () => {
    expect(renderCiTemplateForAdapter('java-junit', 'advisory')).not.toContain('\n  route:\n');
    expect(renderCiTemplateForAdapter('java-junit', 'required')).toContain('\n  route:\n');
  });
});
