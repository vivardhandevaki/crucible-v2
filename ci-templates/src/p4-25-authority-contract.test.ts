import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  CI_TEMPLATE_PATH,
  JAVA_JUNIT_CI_TEMPLATE_PATH,
  renderAuthorityTransitionTemplateForAdapter,
} from './index.js';

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
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
      expect(authorityRun).toContain('git cat-file -e');
      expect(authorityRun).not.toContain('origin "$BASE_SHA" "$HEAD_SHA"');
      const frameworkCheckout = (authority?.steps ?? []).find(
        (step) => step.name === 'Checkout pinned Crucible framework',
      );
      expect(frameworkCheckout?.with).toMatchObject({
        repository: '${{ steps.target.outputs.repository }}',
        ref: '${{ steps.target.outputs.commit }}',
      });
      expect(JSON.stringify(frameworkCheckout?.with)).not.toContain('needs.authority.outputs');
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
    it(label + ': authority transport expands archive moves into additions and removals', () => {
      const authority = workflow(path).jobs?.authority;
      const authorityRun = (authority?.steps ?? []).map((step) => step.run ?? '').join('\n');

      expect(authorityRun).toContain('git diff --no-renames --name-only -z');
    });
  }
  it('renders a non-authoritative legacy bootstrap bridge for both workflow variants', () => {
    const dollar = String.fromCharCode(36);
    for (const adapter of ['stub', 'java-junit']) {
      const value = parseYaml(
        renderAuthorityTransitionTemplateForAdapter(adapter, 'required'),
      ) as Workflow;
      const bootstrap = value.jobs?.['legacy-bootstrap'];
      expect(bootstrap?.if).toBe(dollar + "{{ github.event_name == 'pull_request' }}");
      expect(bootstrap?.permissions).toEqual({ contents: 'read' });
      const bootstrapRun = (bootstrap?.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(bootstrapRun).toContain('manual bootstrap acknowledgement');
      expect(bootstrapRun).not.toContain('ci authority');
      expect(bootstrapRun).not.toContain('ci verify');
      expect(bootstrapRun).not.toContain('ci route');
      for (const name of ['authority', 'verify', 'route']) {
        expect(value.jobs?.[name]?.if).toBe(dollar + "{{ github.event_name != 'pull_request' }}");
      }
    }
  });
});
