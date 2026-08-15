import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from './index.js';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const generic = parseYaml(readFileSync(CI_TEMPLATE_PATH, 'utf8')) as Workflow;
const java = parseYaml(readFileSync(JAVA_JUNIT_CI_TEMPLATE_PATH, 'utf8')) as Workflow;

function step(job: Job | undefined, named: string): Step {
  const found = (job?.steps ?? []).find((candidate) =>
    (candidate.name ?? '').toLowerCase().includes(named.toLowerCase()),
  );
  if (!found) throw new Error(`missing ${named} step`);
  return found;
}

describe.each([
  ['generic', generic],
  ['java-junit', java],
] as const)('managed %s workflow (P4-25)', (_name, workflow) => {
  const authority = workflow.jobs?.authority;
  const verify = workflow.jobs?.verify;
  const route = workflow.jobs?.route;

  it('is base-owned and re-evaluates when a review lands', () => {
    expect(workflow.on && 'pull_request_target' in workflow.on).toBe(true);
    expect(workflow.on && 'pull_request_review' in workflow.on).toBe(true);
    expect(workflow.on && 'pull_request' in workflow.on).toBe(false);
  });

  it('gives the candidate-executing verify job read-only authority', () => {
    expect(verify?.permissions).toEqual({ contents: 'read' });
    const candidate = step(verify, 'Checkout candidate head');
    expect(candidate.with).toMatchObject({
      ref: '${{ github.event.pull_request.head.sha }}',
      'persist-credentials': false,
    });
    const run = step(verify, 'Verify').run ?? '';
    expect(run).not.toContain('GITHUB_OUTPUT');
    expect(run).not.toContain('gh issue');
    expect(run).not.toContain('gh pr comment');
    expect(run).not.toContain('--review');
  });

  it('mints the only mechanical snapshot from exact event SHAs', () => {
    const bootstrap = step(authority, 'Mint complete target-branch enforcement snapshot').run ?? '';
    expect(bootstrap).toContain('github.event.pull_request.base.sha');
    expect(bootstrap).toContain('github.event.pull_request.head.sha');
    expect(bootstrap).toContain('mktemp -d');
    expect(bootstrap).toContain('.crucible/framework.lock.json');
    expect(bootstrap).toContain('snapshot=${process.env.SNAPSHOT}');
    expect(bootstrap).not.toContain('origin/$BASE');
  });

  it('recomputes route independently from candidate bytes and target pin', () => {
    expect(route?.needs).toEqual(['authority', 'verify']);
    expect(route?.permissions).toMatchObject({
      contents: 'read',
      'pull-requests': 'read',
      issues: 'write',
    });
    expect(step(route, 'Checkout candidate data').with).toMatchObject({
      ref: '${{ github.event.pull_request.head.sha }}',
      'persist-credentials': false,
    });
    expect(route?.steps?.some((candidate) => candidate.name === 'Download authority handoff')).toBe(
      true,
    );
    expect(route?.steps?.some((candidate) => (candidate.id ?? '') === 'target')).toBe(false);
    const enforce = step(route, 'Recompute route').run ?? '';
    expect(enforce).toContain(' ci route --manifest ');
    expect(enforce).not.toContain('needs.verify.outputs');
    expect(enforce).toContain('APPROVED');
    expect(enforce).toContain('exit 1');
  });
});

describe('java-junit additions', () => {
  it('keeps JDK and Docker preconditions in the mechanical verify job', () => {
    expect(step(java.jobs?.verify, 'Java').uses).toBe('actions/setup-java@v4');
    const docker = step(java.jobs?.verify, 'Docker').run ?? '';
    expect(docker).toContain('set -euo pipefail');
    expect(docker).toContain('docker info');
  });
});
