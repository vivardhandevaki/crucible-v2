import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from './index.js';

interface Step {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

function load(path: string): Workflow {
  return parseYaml(readFileSync(path, 'utf8')) as Workflow;
}

function step(job: Job | undefined, id: string): Step {
  const found = job?.steps?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing step ${id}`);
  return found;
}

describe('P4-24 managed CI contract', () => {
  for (const [label, workflow] of [
    ['generic', load(CI_TEMPLATE_PATH)],
    ['java-junit', load(JAVA_JUNIT_CI_TEMPLATE_PATH)],
  ] as const) {
    it(`${label}: base owns the executable workflow and candidate verification is credential-free`, () => {
      expect(workflow.on).toHaveProperty('pull_request_target');
      expect(workflow.on).toHaveProperty('pull_request_review');
      expect(workflow.on).not.toHaveProperty('pull_request');

      const verify = workflow.jobs?.verify;
      expect(verify?.permissions).toEqual({ contents: 'read' });
      const checkout = step(verify, 'candidate');
      expect(checkout.uses).toBe('actions/checkout@v4');
      expect(checkout.with).toMatchObject({
        ref: '${{ github.event.pull_request.head.sha }}',
        'persist-credentials': false,
      });
    });

    it(`${label}: one bootstrap step mints every snapshot/pin consumer input`, () => {
      const verify = workflow.jobs?.verify;
      const bootstrap = step(verify, 'target');
      const run = bootstrap.run ?? '';
      expect(run).toContain('mktemp -d');
      expect(run).toContain('snapshot=${process.env.SNAPSHOT}');
      expect(run).toContain('repository=${value.repository}');
      expect(run).toContain('commit=${value.commit}');
      expect(run).toContain('.crucible/framework.lock.json');
      expect(run).not.toContain('origin/$BASE');

      const staleResolver = verify?.steps?.find((candidate) =>
        (candidate.name ?? '').includes('Resolve pinned Crucible framework'),
      );
      expect(staleResolver).toBeUndefined();

      const verifyRun = step(verify, 'verify').run ?? '';
      expect(verifyRun).toContain('steps.target.outputs.snapshot');
      expect(verifyRun).toContain('steps.target.outputs.base_sha');
      expect(verifyRun).not.toContain('origin/$BASE');
      expect(verifyRun).not.toContain('RUNNER_TEMP/crucible-target');
    });

    it(`${label}: independent route bootstrap carries the optional target review workflow`, () => {
      const route = workflow.jobs?.route;
      const bootstrap = step(route, 'target');
      const run = bootstrap.run ?? '';
      expect(run).toContain('REVIEW_WORKFLOW=".github/workflows/crucible-review.yml"');
      expect(run).toContain('git show "$BASE_SHA:$REVIEW_WORKFLOW"');
      expect(run).toContain('snapshot=${process.env.SNAPSHOT}');
    });
  }
});
