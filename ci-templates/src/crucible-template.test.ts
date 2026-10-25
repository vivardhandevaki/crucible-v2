import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from './index.js';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
}
interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
      'runs-on'?: string;
      permissions?: Record<string, string>;
      steps?: Step[];
      'continue-on-error'?: boolean;
    }
  >;
}

function load(path: string): { text: string; workflow: Workflow } {
  const text = readFileSync(path, 'utf8');
  return { text, workflow: parseYaml(text) as Workflow };
}

for (const [label, path] of [
  ['generic', CI_TEMPLATE_PATH],
  ['java-junit', JAVA_JUNIT_CI_TEMPLATE_PATH],
] as const) {
  describe(`P4R-10C ${label} repository-local offering`, () => {
    const { text, workflow } = load(path);
    const job = workflow.jobs?.advisory;
    const steps = job?.steps ?? [];

    it('labels the workflow and check advisory rather than enforcement-grade', () => {
      expect(workflow.name).toBe('Crucible Advisory');
      expect(job?.name).toContain('advisory');
      expect(job?.name).toContain('not a merge authority');
      expect(text).toContain('candidate-controlled');
      expect(text).toContain('ADVISORY');
    });

    it('covers ordinary PRs and merge queues without pull_request_target', () => {
      expect(workflow.on && 'pull_request' in workflow.on).toBe(true);
      expect(workflow.on && 'merge_group' in workflow.on).toBe(true);
      expect(workflow.on && 'pull_request_target' in workflow.on).toBe(false);
    });

    it('uses exact B/H verification but makes no authority claim', () => {
      const execute = steps.find((step) => step.name?.includes('Verify exact'));
      expect(execute?.['working-directory']).toBe('base');
      expect(execute?.run).toContain('./.crucible/bin/crucible --json ci verify');
      expect(execute?.run).toContain('--candidate-root "$GITHUB_WORKSPACE/candidate"');
    });

    it('is restricted, ephemeral, immutable-action-pinned, and fail-closed', () => {
      expect(job?.['runs-on']).toBe('ubuntu-24.04');
      expect(job?.permissions ?? workflow.permissions).toEqual({ contents: 'read' });
      expect(text).not.toMatch(/secrets\./);
      expect(text).not.toContain('actions/cache');
      expect(text).not.toContain('continue-on-error');
      for (const step of steps.filter((candidate) => candidate.uses)) {
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
      for (const checkout of steps.filter((candidate) =>
        candidate.uses?.startsWith('actions/checkout@'),
      )) {
        expect(checkout.with?.['persist-credentials']).toBe(false);
      }
    });
  });
}
