import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from './index.js';

interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string }>;
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function workflow(path: string): Workflow {
  return parseYaml(readFileSync(path, 'utf8')) as Workflow;
}

describe('P4-25 authority workflow contract', () => {
  for (const [label, path] of [
    ['generic', CI_TEMPLATE_PATH],
    ['java-junit', JAVA_JUNIT_CI_TEMPLATE_PATH],
  ] as const) {
    it(label + ': one target-owned authority job gates every consumer', () => {
      const value = workflow(path);
      const authority = value.jobs?.authority;
      const verify = value.jobs?.verify;
      const route = value.jobs?.route;

      expect(authority).toBeDefined();
      expect(authority?.permissions).toEqual({ contents: 'read' });
      const authorityRun = (authority?.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(authorityRun).toContain('ci authority');
      expect(
        (authority?.steps ?? []).some((step) => step.name === 'Upload authority handoff'),
      ).toBe(true);
      expect((verify?.steps ?? []).some((step) => step.name === 'Download authority handoff')).toBe(
        true,
      );
      expect(verify?.needs).toContain('authority');
      expect(route?.needs).toContain('authority');
      expect(verify?.steps?.some((step) => step.name === 'Detect changed change-bundles')).toBe(
        false,
      );
      expect((verify?.steps ?? []).map((step) => step.run ?? '').join('\n')).toContain('ci verify');
      expect((route?.steps ?? []).map((step) => step.run ?? '').join('\n')).toContain('ci route');
    });
  }
});
