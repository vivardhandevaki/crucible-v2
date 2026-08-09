import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CI_REVIEW_TEMPLATE_PATH } from './index.js';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Job {
  steps?: Step[];
  permissions?: Record<string, string>;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflow = parseYaml(readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8')) as Workflow;

function job(name: string): Job {
  const result = workflow.jobs?.[name];
  if (!result) throw new Error(`missing ${name} job`);
  return result;
}

function step(jobName: string, name: string): Step {
  const result = job(jobName).steps?.find((entry) => entry.name?.toLowerCase().includes(name));
  if (!result) throw new Error(`missing ${name} step in ${jobName}`);
  return result;
}

describe('crucible-review.yml — detached credentialed reviewer (P4-14)', () => {
  it('is target-branch-owned and has separate prepare, action, and secretless judge jobs', () => {
    expect(workflow.name).toBe('Crucible review');
    expect(workflow.on && 'pull_request_target' in workflow.on).toBe(true);
    expect(job('prepare')).toBeTruthy();
    expect(job('review-agent')).toBeTruthy();
    expect(job('judge')).toBeTruthy();
  });

  it('never checks out or executes PR code in the credentialed job', () => {
    const agent = job('review-agent');
    expect(agent.steps?.some((entry) => entry.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(agent.steps?.some((entry) => entry.run?.includes('npm ci'))).toBe(false);
    expect(
      agent.steps?.some((entry) => entry.run?.includes('mvn') || entry.run?.includes('gradle')),
    ).toBe(false);
  });

  it('pins the official action and scopes the API key only to its input', () => {
    const action = step('review-agent', 'codex');
    expect(action.uses).toMatch(/^openai\/codex-action@[0-9a-f]{40}$/);
    expect(action.with?.['openai-api-key']).toBe('${{ secrets.OPENAI_API_KEY }}');
    expect(action.with?.['codex-version']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(action.with?.['safety-strategy']).toBe('drop-sudo');
    expect(action.with?.['permission-profile']).toBe(':read-only');
    expect(action.with?.['allow-users']).toBeUndefined();
    expect(action.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it('keeps the secret-bearing action last and leaves judgment to a secretless core job', () => {
    const agentSteps = job('review-agent').steps ?? [];
    expect(agentSteps.at(-1)?.name?.toLowerCase()).toContain('codex');
    const judge = step('judge', 'judge');
    expect(judge.run).toContain('ci-review judge');
    expect(judge.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it('uses target-branch framework/config and rejects untrusted actors rather than broadening access', () => {
    const prepare = job('prepare');
    const text = (prepare.steps ?? []).map((entry) => entry.run ?? '').join('\n');
    expect(text).toContain('github.event.pull_request.base.sha');
    expect(text).toContain('github.event.pull_request.head.sha');
    expect(text).toContain("'show'");
    expect(text).toContain('ci-review prepare');
    expect(JSON.stringify(workflow)).not.toContain('allow-users: "*"');
  });
});
