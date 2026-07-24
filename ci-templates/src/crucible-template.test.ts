import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH } from './index.js';

// Structural validation of the shipped enforcement workflow (P1-15). The workflow
// is data, not code, so its guarantees are asserted by parsing it and checking the
// invariant-#7 shape — the half of P1-15's acceptance that IS executable in P1:
//
//   - the enforcement config is sourced from the TARGET branch (origin/<base_ref>),
//     written outside the PR tree, and handed to verify via `--config-from`
//     (charter §The Target-Branch Rule, invariant #7); the PR's own crucible.yaml
//     is never used as enforcement config;
//   - a red verify verdict fails the check — no error-swallowing anywhere on the
//     gate (fail-closed, invariant #3).
//
// The *executable* proof (a PR that loosens a glob and still fails) needs verify
// to consume `--config-from`, which is P2-03; that proof is tracked as P2-18.

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  id?: string;
  'continue-on-error'?: boolean;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  jobs?: Record<string, { steps?: Step[]; 'continue-on-error'?: boolean }>;
}

const workflow = parseYaml(readFileSync(CI_TEMPLATE_PATH, 'utf8')) as Workflow;
const steps = workflow.jobs?.verify?.steps ?? [];

/** The first step whose name contains `fragment` (case-insensitive). */
function stepNamed(fragment: string): Step {
  const found = steps.find((s) => (s.name ?? '').toLowerCase().includes(fragment.toLowerCase()));
  if (!found) throw new Error(`no step named like "${fragment}" in the workflow`);
  return found;
}

describe('crucible.yml — a pull-request enforcement gate', () => {
  it('is named and triggers on pull_request', () => {
    expect(workflow.name).toBe('Crucible');
    // `on:` is parsed as a string key under YAML 1.2 (not coerced to boolean).
    expect(workflow.on && 'pull_request' in workflow.on).toBe(true);
  });

  it('runs a `verify` job with steps', () => {
    expect(steps.length).toBeGreaterThan(0);
  });
});

describe('crucible.yml — the Target-Branch Rule (invariant #7)', () => {
  it('extracts enforcement config from the target branch, outside the PR tree', () => {
    const run = stepNamed('target-branch enforcement config').run ?? '';
    // Sourced from origin/<base_ref> — the branch being merged INTO.
    expect(run).toContain('github.base_ref');
    expect(run).toContain('git show');
    expect(run).toContain(':crucible.yaml');
    // Written under RUNNER_TEMP (outside the working tree) so the PR's own copy
    // can never shadow the target-branch config.
    expect(run).toContain('RUNNER_TEMP/crucible-target');
  });

  it('passes the target-branch config to verify via --config-from (CLI-parseable order)', () => {
    const run = stepNamed('verify').run ?? '';
    // The actual invocation line — not the `echo ::group::` label, which also
    // mentions "verify". Assert the flag/subcommand order on the real command.
    const invocation = run.split('\n').find((l) => l.includes('npx') && l.includes('verify '));
    expect(invocation, 'an `npx crucible ... verify` invocation line').toBeTruthy();
    const cmd = invocation ?? '';
    expect(cmd).toContain('--config-from');
    // The config-from directory is the extracted target-branch config, NOT the PR
    // working tree — this is the whole point of invariant #7.
    expect(cmd).toContain('RUNNER_TEMP/crucible-target');
    // The global flag must precede the subcommand, the form the CLI parses.
    expect(cmd.indexOf('--config-from')).toBeLessThan(cmd.indexOf(' verify '));
  });

  it('never feeds the PR working-tree crucible.yaml in as enforcement config', () => {
    const run = stepNamed('verify').run ?? '';
    // The only --config-from source is the target-branch temp dir. Guard against a
    // regression that points it at the checked-out (PR) crucible.yaml.
    expect(run).not.toMatch(/--config-from\s+\.?\/?crucible\.yaml/);
    expect(run).not.toMatch(/--config-from\s+["']?\$?\{?\{?\s*github\.workspace/);
  });
});

describe('crucible.yml — fail-closed gate (verify red → check red, invariant #3)', () => {
  it('has no step that swallows the verify failure', () => {
    const run = stepNamed('verify').run ?? '';
    expect(run).not.toContain('|| true');
    expect(run).not.toContain('|| exit 0');
    expect(run).not.toContain('continue-on-error');
  });

  it('sets no continue-on-error anywhere on the gate', () => {
    expect(workflow.jobs?.verify?.['continue-on-error']).toBeUndefined();
    for (const step of steps) {
      expect(step['continue-on-error']).not.toBe(true);
    }
  });

  it('runs the config-extraction and verify steps under a fail-closed shell', () => {
    // `set -euo pipefail`: a failed git-show (no target config) or a non-zero
    // verify aborts the step rather than continuing past the error.
    expect(stepNamed('target-branch enforcement config').run ?? '').toContain('set -euo pipefail');
    expect(stepNamed('verify').run ?? '').toContain('set -euo pipefail');
  });
});
