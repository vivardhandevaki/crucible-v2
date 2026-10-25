import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CI_TEMPLATE_PATH } from './index.js';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
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

const text = readFileSync(REQUIRED_CI_TEMPLATE_PATH, 'utf8');
const workflow = parseYaml(text) as Workflow;
const job = workflow.jobs?.verify;
const steps = job?.steps ?? [];

function step(fragment: string): Step {
  const found = steps.find((candidate) =>
    (candidate.name ?? '').toLowerCase().includes(fragment.toLowerCase()),
  );
  if (!found) throw new Error(`missing step named like ${fragment}`);
  return found;
}

describe('P4R-10B organization-ruleset required workflow', () => {
  it('supports restricted pull_request and merge_group without pull_request_target', () => {
    expect(workflow.on && 'pull_request' in workflow.on).toBe(true);
    expect(workflow.on && 'merge_group' in workflow.on).toBe(true);
    expect(workflow.on && 'pull_request_target' in workflow.on).toBe(false);
  });

  it('uses one stable expected-source workflow/check identity', () => {
    expect(workflow.name).toBe('Crucible Required Verify');
    expect(job?.name).toBe('Crucible deterministic verify');
  });

  it('derives exact event B/H values before checkout and revalidates them in the base CLI', () => {
    const identities = step('derive exact');
    const execute = step('verify exact');
    expect(identities.env?.EVENT_PATH).toBe('${{ github.event_path }}');
    expect(identities.run).toContain('process.env.EVENT_PATH');
    expect(identities.run).toContain('pull_request');
    expect(identities.run).toContain('merge_group');
    expect(identities.run).toContain('[0-9a-f]{40}');
    expect(execute['working-directory']).toBe('base');
    expect(execute.run).toContain('./.crucible/bin/crucible --json ci verify');
    expect(execute.run).toContain('--base-sha "$BASE_SHA"');
    expect(execute.run).toContain('--candidate-sha "$CANDIDATE_SHA"');
    expect(execute.run).toContain('--candidate-root "$GITHUB_WORKSPACE/candidate"');
    expect(execute.run).toContain('--target-tip-root "$GITHUB_WORKSPACE/target-tip"');
  });

  it('checks out exact B, exact H, and the independently observed target tip', () => {
    const base = step('exact base');
    const candidate = step('exact candidate');
    const tip = step('current target tip');
    expect(base.with).toMatchObject({
      repository: '${{ steps.identities.outputs.base_repository }}',
      ref: '${{ steps.identities.outputs.base_sha }}',
      path: 'base',
      'persist-credentials': false,
    });
    expect(candidate.with).toMatchObject({
      repository: '${{ steps.identities.outputs.candidate_repository }}',
      ref: '${{ steps.identities.outputs.candidate_sha }}',
      path: 'candidate',
      'persist-credentials': false,
    });
    expect(tip.with).toMatchObject({
      repository: '${{ steps.identities.outputs.base_repository }}',
      ref: '${{ steps.identities.outputs.base_ref }}',
      path: 'target-tip',
      'persist-credentials': false,
    });
  });

  it('pins every third-party action to an immutable commit SHA', () => {
    const actionSteps = steps.filter((candidate) => candidate.uses);
    expect(actionSteps.length).toBeGreaterThan(0);
    for (const action of actionSteps) {
      expect(action.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('gives candidate execution no secret, write token, credential persistence, cache, or persistent runner', () => {
    expect(job?.['runs-on']).toBe('ubuntu-24.04');
    expect(job?.['runs-on']).not.toContain('self-hosted');
    expect(job?.permissions ?? workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/permissions:[\s\S]*\bwrite\b/);
    expect(text).not.toContain('actions/cache');
    expect(text).not.toContain('continue-on-error');
    expect(workflow.concurrency?.['cancel-in-progress']).not.toBe(true);
    for (const checkout of steps.filter((candidate) =>
      candidate.uses?.startsWith('actions/checkout@'),
    )) {
      expect(checkout.with?.['persist-credentials']).toBe(false);
    }
  });
});
