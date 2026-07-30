import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from './index.js';

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
// As of P2-03 verify CONSUMES `--config-from`, so the executable behavioral proof
// (a PR that loosens a glob and still routes to human) is delivered by P2-18's
// hermetic target-branch-rule test. This file asserts the workflow's *structure*:
// target-branch sourcing, the fail-closed gate, and the new `route` job that holds
// a critical change red until a non-author approves (design phase-2.md §2).

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  id?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}

interface Job {
  steps?: Step[];
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  'continue-on-error'?: boolean;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflow = parseYaml(readFileSync(CI_TEMPLATE_PATH, 'utf8')) as Workflow;
const steps = workflow.jobs?.verify?.steps ?? [];
const javaWorkflow = parseYaml(readFileSync(JAVA_JUNIT_CI_TEMPLATE_PATH, 'utf8')) as Workflow;

/** The first step of `job` whose name contains `fragment` (case-insensitive). */
function stepOf(job: Job | undefined, fragment: string): Step {
  const found = (job?.steps ?? []).find((s) =>
    (s.name ?? '').toLowerCase().includes(fragment.toLowerCase()),
  );
  if (!found) throw new Error(`no step named like "${fragment}" in the job`);
  return found;
}

/** The first verify-job step whose name contains `fragment`. */
function stepNamed(fragment: string): Step {
  return stepOf(workflow.jobs?.verify, fragment);
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

describe('crucible-java-junit.yml — JDK + Testcontainers variant (P3-07)', () => {
  it('preserves the same verify and route enforcement jobs', () => {
    expect(javaWorkflow.jobs?.verify).toBeTruthy();
    expect(javaWorkflow.jobs?.route?.needs).toBe('verify');
  });

  it('sets up a pinned JDK before verification', () => {
    const java = stepOf(javaWorkflow.jobs?.verify, 'java');
    expect(java.uses).toBe('actions/setup-java@v4');
    expect(java.with).toMatchObject({ distribution: 'temurin', 'java-version': '17' });
  });

  it('fails closed unless the Docker service is ready for Testcontainers', () => {
    const docker = stepOf(javaWorkflow.jobs?.verify, 'docker');
    expect(docker.run).toContain('docker info');
    expect(docker.run).toContain('set -euo pipefail');
    expect(docker['continue-on-error']).not.toBe(true);
  });

  it('retains target-branch enforcement in the JVM variant', () => {
    const extract = stepOf(javaWorkflow.jobs?.verify, 'target-branch enforcement config').run ?? '';
    const verifyRun = stepOf(javaWorkflow.jobs?.verify, 'verify').run ?? '';
    expect(extract).toContain('git show');
    expect(extract).toContain('origin/$BASE:crucible.yaml');
    expect(verifyRun).toContain('--config-from "$RUNNER_TEMP/crucible-target"');
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

describe('crucible.yml — tier routing (P2-03, design phase-2.md §2)', () => {
  const route = workflow.jobs?.route;

  it('diffs against the target branch so the tier is computed vs origin/<base_ref>', () => {
    const cmd = (stepNamed('verify').run ?? '')
      .split('\n')
      .find((l) => l.includes('npx') && l.includes('verify '));
    expect(cmd, 'an `npx crucible ... verify` invocation line').toBeTruthy();
    // --diff-base is a verify subcommand option (after `verify <change>`) pointed
    // at the target branch — the tier/cap are judged against origin/<base_ref>.
    expect(cmd).toContain('--diff-base');
    expect(cmd).toContain('origin/');
  });

  it('the verify job exposes the routing decision as a job output', () => {
    // route (a separate job) consumes routing via a job output — the verify step
    // writes it to $GITHUB_OUTPUT and the job re-exports it.
    expect(workflow.jobs?.verify?.outputs?.routing).toBeTruthy();
    expect(stepNamed('verify').run ?? '').toContain('GITHUB_OUTPUT');
  });

  it('re-evaluates when a review lands (pull_request_review trigger)', () => {
    // So the check flips green the moment the required approval arrives.
    expect(workflow.on && 'pull_request_review' in workflow.on).toBe(true);
  });

  it('has a required `route` job gated on verify with pull-requests: read', () => {
    expect(route, 'a route job').toBeTruthy();
    // route depends on verify (only routes an already-green change).
    const needs = route?.needs;
    expect(Array.isArray(needs) ? needs.includes('verify') : needs === 'verify').toBe(true);
    // The reviews query needs pull-requests: read (job- or workflow-level).
    const perms = route?.permissions ?? workflow.permissions ?? {};
    expect(perms['pull-requests']).toBe('read');
  });

  it('critical → human: route stays red until a NON-AUTHOR APPROVED review exists', () => {
    const run = stepOf(route, 'routing').run ?? '';
    // Only human routing blocks; auto passes.
    expect(run).toContain('human');
    // It queries reviews for an APPROVED state from someone other than the author.
    expect(run).toContain('APPROVED');
    expect(run.toLowerCase()).toContain('author');
    // Blocking is a hard failure (exit 1) — the required check stays red.
    expect(run).toContain('exit 1');
  });

  it('the route gate is fail-closed — no swallowed failure', () => {
    const run = stepOf(route, 'routing').run ?? '';
    expect(run).not.toContain('|| true');
    expect(run).not.toContain('|| exit 0');
    expect(route?.['continue-on-error']).not.toBe(true);
    for (const step of route?.steps ?? []) {
      expect(step['continue-on-error']).not.toBe(true);
    }
  });
});

describe('crucible.yml — override ratchet issue (P2-06, design phase-2.md §3)', () => {
  it('grants issues: write so the override ratchet issue can be filed', () => {
    // Workflow- or verify-job level. The forced-human teeth come from routing;
    // this permission is only for the self-repairing paper trail.
    const perms = workflow.jobs?.verify?.permissions ?? workflow.permissions ?? {};
    expect(perms.issues).toBe('write');
  });

  it('captures the override issue payload verify emits in its --json report', () => {
    // The verify loop stashes `.override.issue` for the filing step — CI never
    // builds the payload itself; the core emits it (design §3, no token plumbing).
    const run = stepNamed('verify').run ?? '';
    expect(run).toContain('.override.issue');
  });

  it('files the ratchet issue idempotently, searching the crucible-override label first', () => {
    const step = stepNamed('override ratchet');
    const run = step.run ?? '';
    // Searches OPEN crucible-override issues for the change before creating one.
    expect(run).toContain('crucible-override');
    expect(run).toContain('gh issue list');
    expect(run).toContain('--state open');
    // Only creates when none exists (idempotency: no duplicate on PR re-runs).
    expect(run).toContain('gh issue create');
    // Uses the ambient token, not any bespoke plumbing.
    expect(step.env?.GH_TOKEN).toBeTruthy();
  });

  it('the filing step is fail-closed — no swallowed failure', () => {
    const run = stepNamed('override ratchet').run ?? '';
    expect(run).toContain('set -euo pipefail');
    expect(run).not.toContain('|| true');
    expect(run).not.toContain('|| exit 0');
    expect(stepNamed('override ratchet')['continue-on-error']).not.toBe(true);
  });
});

describe('crucible.yml — adversarial reviewer (P2-10, design phase-2.md §5)', () => {
  it('CI always runs the reviewer: the verify invocation passes --review', () => {
    const cmd = (stepNamed('verify').run ?? '')
      .split('\n')
      .find((l) => l.includes('npx') && l.includes('verify '));
    expect(cmd, 'an `npx crucible ... verify` invocation line').toBeTruthy();
    // "verify --review optional locally; CI always" — the shipped gate opts in.
    expect(cmd).toContain('--review');
  });

  it('captures the reviewer observations verify emits in its --json report', () => {
    // The verify loop stashes `.review.observations` for the PR-comment step —
    // CI never invents observations; the core emits them (design §5).
    const run = stepNamed('verify').run ?? '';
    expect(run).toContain('.review.observations');
  });

  it('grants pull-requests: write on the verify job so observations can be posted', () => {
    const perms = workflow.jobs?.verify?.permissions ?? workflow.permissions ?? {};
    expect(perms['pull-requests']).toBe('write');
  });

  it('posts observations as ONE marker-tagged PR comment, updated in place (no spam on re-runs)', () => {
    const step = stepNamed('observations');
    const run = step.run ?? '';
    // A stable marker identifies the Crucible observations comment; --edit-last
    // + --create-if-none updates it in place instead of stacking duplicates.
    expect(run).toContain('crucible-observations');
    expect(run).toContain('gh pr comment');
    expect(run).toContain('--edit-last');
    expect(run).toContain('--create-if-none');
    expect(step.env?.GH_TOKEN).toBeTruthy();
  });

  it('the observations step is fail-closed — the harvest channel is not droppable', () => {
    const run = stepNamed('observations').run ?? '';
    expect(run).toContain('set -euo pipefail');
    expect(run).not.toContain('|| true');
    expect(run).not.toContain('|| exit 0');
    expect(stepNamed('observations')['continue-on-error']).not.toBe(true);
  });
});
