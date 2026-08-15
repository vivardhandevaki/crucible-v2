import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
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

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function outputs(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
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

describe('P4-24 bootstrap — exact script against real Git', () => {
  let root: string;

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [label, path] of [
    ['generic', CI_TEMPLATE_PATH],
    ['java-junit', JAVA_JUNIT_CI_TEMPLATE_PATH],
  ] as const) {
    it(`${label}: hostile candidate enforcement bytes are inert`, () => {
      root = mkdtempSync(join(tmpdir(), 'crucible-p4-24-git-'));
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test']);
      mkdirSync(join(root, '.crucible'), { recursive: true });
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(root, 'crucible.yaml'), 'base-config\n');
      writeFileSync(
        join(root, '.crucible', 'framework.lock.json'),
        '{"version":1,"repository":"owner/framework","commit":"0123456789abcdef0123456789abcdef01234567"}\n',
      );
      writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'base-workflow\n');
      writeFileSync(join(root, '.github', 'workflows', 'crucible-review.yml'), 'base-review\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'base']);
      const base = git(root, ['rev-parse', 'HEAD']);
      const origin = join(root, 'origin.git');
      execFileSync('git', ['clone', '--bare', root, origin], { stdio: 'ignore' });
      git(root, ['remote', 'add', 'origin', origin]);
      git(root, ['checkout', '-qb', 'candidate']);
      writeFileSync(join(root, 'crucible.yaml'), 'hostile-config\n');
      writeFileSync(join(root, '.crucible', 'framework.lock.json'), '{"version":999}\n');
      writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'hostile-workflow\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'candidate']);
      const head = git(root, ['rev-parse', 'HEAD']);
      const output = join(root, 'github-output');
      const run = (parseYaml(readFileSync(path, 'utf8')) as Workflow).jobs?.verify?.steps?.find(
        (candidate) => candidate.id === 'target',
      )?.run;
      if (!run) throw new Error('missing target bootstrap');
      const script = run
        .replaceAll('${{ github.event.pull_request.base.sha }}', base)
        .replaceAll('${{ github.event.pull_request.head.sha }}', head);
      execFileSync('bash', ['-c', script], {
        cwd: root,
        env: { ...process.env, RUNNER_TEMP: join(root, 'tmp'), GITHUB_OUTPUT: output },
        stdio: 'pipe',
      });
      const minted = outputs(readFileSync(output, 'utf8'));
      const snapshot = minted.snapshot;
      if (snapshot === undefined) throw new Error('bootstrap did not emit snapshot');
      expect(readFileSync(join(snapshot, 'crucible.yaml'), 'utf8')).toBe('base-config\n');
      expect(readFileSync(join(snapshot, '.crucible', 'framework.lock.json'), 'utf8')).toContain(
        '"version":1',
      );
      expect(readFileSync(join(snapshot, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
        'base-workflow\n',
      );
      expect(
        readFileSync(join(snapshot, '.github', 'workflows', 'crucible-review.yml'), 'utf8'),
      ).toBe('base-review\n');
      expect(minted).toMatchObject({
        base_sha: base,
        head_sha: head,
        repository: 'owner/framework',
      });
    });

    it(`${label}: malformed target pin aborts before it emits a handoff`, () => {
      root = mkdtempSync(join(tmpdir(), 'crucible-p4-24-invalid-pin-'));
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test']);
      mkdirSync(join(root, '.crucible'), { recursive: true });
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(root, 'crucible.yaml'), 'base-config\n');
      writeFileSync(join(root, '.crucible', 'framework.lock.json'), '{"version":999}\n');
      writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'base-workflow\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'invalid base pin']);
      const base = git(root, ['rev-parse', 'HEAD']);
      const origin = join(root, 'origin.git');
      execFileSync('git', ['clone', '--bare', root, origin], { stdio: 'ignore' });
      git(root, ['remote', 'add', 'origin', origin]);
      const output = join(root, 'github-output');
      const run = (parseYaml(readFileSync(path, 'utf8')) as Workflow).jobs?.verify?.steps?.find(
        (candidate) => candidate.id === 'target',
      )?.run;
      if (!run) throw new Error('missing target bootstrap');
      const script = run
        .replaceAll('${{ github.event.pull_request.base.sha }}', base)
        .replaceAll('${{ github.event.pull_request.head.sha }}', base);
      expect(() =>
        execFileSync('bash', ['-c', script], {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: join(root, 'tmp'), GITHUB_OUTPUT: output },
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(existsSync(output)).toBe(false);
    });

    it(`${label}: symlinked target config aborts before it emits a handoff`, () => {
      root = mkdtempSync(join(tmpdir(), 'crucible-p4-24-symlink-'));
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test']);
      mkdirSync(join(root, '.crucible'), { recursive: true });
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(root, 'actual-config.yaml'), 'base-config\n');
      symlinkSync('actual-config.yaml', join(root, 'crucible.yaml'));
      writeFileSync(
        join(root, '.crucible', 'framework.lock.json'),
        '{"version":1,"repository":"owner/framework","commit":"0123456789abcdef0123456789abcdef01234567"}\n',
      );
      writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'base-workflow\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'symlink base config']);
      const base = git(root, ['rev-parse', 'HEAD']);
      const origin = join(root, 'origin.git');
      execFileSync('git', ['clone', '--bare', root, origin], { stdio: 'ignore' });
      git(root, ['remote', 'add', 'origin', origin]);
      const output = join(root, 'github-output');
      const run = (parseYaml(readFileSync(path, 'utf8')) as Workflow).jobs?.verify?.steps?.find(
        (candidate) => candidate.id === 'target',
      )?.run;
      if (!run) throw new Error('missing target bootstrap');
      const script = run
        .replaceAll('${{ github.event.pull_request.base.sha }}', base)
        .replaceAll('${{ github.event.pull_request.head.sha }}', base);
      expect(() =>
        execFileSync('bash', ['-c', script], {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: join(root, 'tmp'), GITHUB_OUTPUT: output },
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(existsSync(output)).toBe(false);
    });

    it(`${label}: missing required target workflow cannot reuse stale handoff output`, () => {
      root = mkdtempSync(join(tmpdir(), 'crucible-p4-24-missing-'));
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test']);
      mkdirSync(join(root, '.crucible'), { recursive: true });
      writeFileSync(join(root, 'crucible.yaml'), 'base-config\n');
      writeFileSync(
        join(root, '.crucible', 'framework.lock.json'),
        '{"version":1,"repository":"owner/framework","commit":"0123456789abcdef0123456789abcdef01234567"}\n',
      );
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'missing main workflow']);
      const base = git(root, ['rev-parse', 'HEAD']);
      const origin = join(root, 'origin.git');
      execFileSync('git', ['clone', '--bare', root, origin], { stdio: 'ignore' });
      git(root, ['remote', 'add', 'origin', origin]);
      const output = join(root, 'github-output');
      writeFileSync(output, 'snapshot=/stale\nrepository=stale/repo\n');
      const run = (parseYaml(readFileSync(path, 'utf8')) as Workflow).jobs?.verify?.steps?.find(
        (candidate) => candidate.id === 'target',
      )?.run;
      if (!run) throw new Error('missing target bootstrap');
      const script = run
        .replaceAll('${{ github.event.pull_request.base.sha }}', base)
        .replaceAll('${{ github.event.pull_request.head.sha }}', base);
      expect(() =>
        execFileSync('bash', ['-c', script], {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: join(root, 'tmp'), GITHUB_OUTPUT: output },
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(readFileSync(output, 'utf8')).toBe('snapshot=/stale\nrepository=stale/repo\n');
    });
  }
});
