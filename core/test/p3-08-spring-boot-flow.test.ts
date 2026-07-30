import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPinnedAdapterClient } from '../src/adapters/runtime.js';
import { approve } from '../src/commands/approve.js';
import { implement } from '../src/commands/implement.js';
import { init } from '../src/commands/init.js';
import { detectAnswers } from '../src/commands/init.cli.js';
import { propose } from '../src/commands/propose.js';
import { review } from '../src/commands/review.js';
import { verify } from '../src/commands/verify.js';
import { loadEnforcementConfig } from '../src/config/enforcement.js';
import { rubricHash } from '../src/review/rubric.js';
import { ClaudeCodeSubstrate } from '../src/substrate/claude-code.js';
import { CodexSubstrate } from '../src/substrate/codex.js';
import { FakeSubstrate } from '../src/substrate/fake.js';
import type { AgentSubstrate, SubstrateRequest } from '../src/substrate/types.js';

// P3-08 acceptance: the first consumer-shaped proof. Only agent calls are faked
// in CI; init, adapter package pinning, JUnit discovery/execution, artifact
// parsing, lint, sealing, local verify, CI-tier computation, and reviewer verdict
// parsing are production paths. Manual mode swaps the FakeSubstrate for Codex or
// Claude Code while retaining the same fixture and judges.

const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MONOREPO_ROOT = dirname(CORE_ROOT);
const FIXTURE = join(MONOREPO_ROOT, 'fixtures', 'spring-hello-world');
const CANNED = join(FIXTURE, 'canned');
const FRAMEWORK_CI = join(MONOREPO_ROOT, '.github', 'workflows', 'ci.yml');
const ADAPTER_PACKAGE = join(MONOREPO_ROOT, 'adapters', 'java-junit', 'package');

const CHANGE = 'greet-world';
const PHASE_LEDGER = join(MONOREPO_ROOT, 'PHASES.md');
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const TASKS_REL = join(CHANGE_REL, 'tasks.md');
const ORACLES_REL = join(CHANGE_REL, 'oracles.md');
const APP_REL = join('src', 'main', 'java', 'com', 'crucible', 'hello', 'GreetingService.java');
const TEST_REL = join(
  'src',
  'test',
  'java',
  'com',
  'crucible',
  'hello',
  'GreetingApplicationTest.java',
);
const TARGET = 'com.crucible.hello.GreetingApplicationTest#greetsWorldFromSpringContext';
const INTENT =
  'Make the Spring Boot greeting service return "Hello, world!" and prove it from the application context.';
const APPROVER = 'p3-08@example.com';
const CANNED_RELS = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  TEST_REL,
] as const;

const REAL_SELECTOR = process.env['CRUCIBLE_REAL_SUBSTRATE'];
const REAL = ['1', 'claude-code', 'codex'].includes(REAL_SELECTOR ?? '');
const REAL_PROVIDER = REAL_SELECTOR === 'codex' ? 'codex' : 'claude-code';
const REAL_MODEL =
  process.env['CRUCIBLE_REAL_MODEL'] ??
  (REAL_PROVIDER === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-4-8');
const HAS_JVM =
  spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('mvn', ['-v'], { encoding: 'utf8' }).status === 0;

let scratch: string;
let now: () => string;
let baselineSha = '';

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-p3-08-'));
  cpSync(FIXTURE, scratch, { recursive: true });
  rmSync(join(scratch, 'canned'), { recursive: true, force: true });

  await init(
    {
      root: scratch,
      answers: detectAnswers(scratch),
      adapterPackage: {
        manifestPath: join(ADAPTER_PACKAGE, 'crucible-adapter.yaml'),
        executablePath: join(ADAPTER_PACKAGE, 'java-junit.mjs'),
      },
    },
    { confirmOverwrite: () => true },
  );

  now = tickingClock();
  if (REAL) {
    git(['init', '-q']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Crucible P3-08',
      '-c',
      'user.email=p3-08@example.com',
      'commit',
      '-qm',
      'Spring baseline',
    ]);
    baselineSha = gitText(['rev-parse', 'HEAD']);
  }
});

afterEach(() => {
  if (!REAL) rmSync(scratch, { recursive: true, force: true });
});

function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-30T12:00:${String(tick++).padStart(2, '0')}Z`;
}

function git(args: readonly string[]): void {
  execFileSync('git', [...args], { cwd: scratch, stdio: 'ignore' });
}

function gitText(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: scratch, encoding: 'utf8' }).trim();
}

function fakeScaffold(change: string): Promise<void> {
  const dir = join(scratch, 'openspec', 'changes', change);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.openspec.yaml'), 'schema: crucible\ncreated: 2026-07-30\n');
  return Promise.resolve();
}

function cannedProposal(disabled = false): Record<string, string> {
  const files = Object.fromEntries(
    CANNED_RELS.map((rel) => [rel, readFileSync(join(CANNED, rel), 'utf8')]),
  );
  if (disabled) {
    files[TEST_REL] = files[TEST_REL]!.replace(
      '    @Test\n',
      '    @org.junit.jupiter.api.Disabled("P3-08 skip negative")\n    @Test\n',
    );
  }
  return files;
}

function fakeImplementSubstrate(): FakeSubstrate {
  let call = 0;
  return new FakeSubstrate(() => {
    call += 1;
    if (call === 1) {
      return {
        files: {
          [TASKS_REL]: '# Tasks\n\n- [ ] 1.1 Return the approved greeting from GreetingService.\n',
        },
      };
    }
    return { files: { [APP_REL]: implementedGreetingSource() } };
  });
}

function implementedGreetingSource(): string {
  return [
    'package com.crucible.hello;',
    '',
    'import org.springframework.stereotype.Service;',
    '',
    '@Service',
    'public class GreetingService {',
    '    public String greet() {',
    '        return "Hello, world!";',
    '    }',
    '}',
    '',
  ].join('\n');
}

function fakeReviewer(head: string): FakeSubstrate {
  return new FakeSubstrate((request: SubstrateRequest) => {
    const match = request.taskPayload.match(/(\.crucible\/verdicts\/\S+\.json)/);
    if (match === null) throw new Error('review payload did not name its verdict path');
    return {
      files: {
        [match[1]!]: JSON.stringify({
          change: CHANGE,
          reviewed_sha: head,
          rubric_hash: rubricHash(join(scratch, '.crucible', 'rubric.yaml')),
          model: 'gpt-5.6-sol',
          verdict: 'pass',
          findings: [],
          observations: [],
        }),
      },
    };
  });
}

function liveSubstrate(): AgentSubstrate {
  return REAL_PROVIDER === 'codex' ? new CodexSubstrate() : new ClaudeCodeSubstrate();
}

async function doPropose(substrate: AgentSubstrate) {
  const adapter = loadPinnedAdapterClient(scratch);
  return propose(
    { root: scratch, change: CHANGE, intent: INTENT, model: REAL_MODEL },
    {
      substrate,
      scaffold: fakeScaffold,
      resolve: (targets) => adapter.resolve(targets),
      now,
    },
  );
}

async function doApprove() {
  const adapter = loadPinnedAdapterClient(scratch);
  return approve(
    { root: scratch, change: CHANGE, yes: true },
    {
      resolve: (targets) => adapter.resolve(targets),
      confirm: () => Promise.reject(new Error('confirm is unreachable under --yes')),
      now,
      approvedBy: () => APPROVER,
    },
  );
}

async function doImplement(substrate: AgentSubstrate) {
  const adapter = loadPinnedAdapterClient(scratch);
  return implement(
    { root: scratch, change: CHANGE, model: REAL_MODEL },
    {
      substrate,
      resolve: (targets) => adapter.resolve(targets),
      run: (oracles) => adapter.run(oracles),
      now,
    },
  );
}

async function doVerify() {
  const adapter = loadPinnedAdapterClient(scratch);
  return verify(
    { root: scratch, change: CHANGE },
    {
      resolve: (targets) => adapter.resolve(targets),
      run: (oracles) => adapter.run(oracles),
    },
  );
}

async function doCiVerify(substrate: AgentSubstrate, base = 'target/main', head = 'feature/head') {
  const adapter = loadPinnedAdapterClient(scratch);
  return verify(
    {
      root: scratch,
      change: CHANGE,
      config: loadEnforcementConfig(scratch),
    },
    {
      resolve: (targets) => adapter.resolve(targets),
      run: (oracles) => adapter.run(oracles),
      diffFacts: () => ({
        touchedPaths: [APP_REL, TEST_REL, join(CHANGE_REL, 'proposal.md')],
        diffLines: 40,
      }),
      review: async () => {
        const result = await review(
          { root: scratch, change: CHANGE, model: REAL_MODEL, base, head },
          { substrate, now },
        );
        return { check: result.check, review: result.review };
      },
    },
  );
}

describe('P3-08 CI contract', () => {
  it('framework CI provisions Java before the real-adapter acceptance test', () => {
    const workflow = readFileSync(FRAMEWORK_CI, 'utf8');
    expect(workflow).toContain('actions/setup-java@v4');
    expect(workflow).toContain("java-version: '17'");
  });

  it('records the Phase 3 exit criterion as done without hiding follow-up work', () => {
    const phaseThree = readFileSync(PHASE_LEDGER, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('| 3 |'));
    expect(phaseThree).toContain('☑ done');
  });
});

describe.skipIf(REAL)('P3-08 Spring Boot loop (FakeSubstrate in CI)', () => {
  it(
    'runs init → propose → approve → implement → verify → CI green with java-junit',
    { timeout: 600_000 },
    async () => {
      expect(HAS_JVM, 'P3-08 acceptance requires Java and Maven').toBe(true);

      const proposed = await doPropose(new FakeSubstrate({ files: cannedProposal() }));
      expect(proposed.report.verdict).toBe('pass');
      expect(proposed.report.checks[0]?.findings).toEqual([]);

      const approved = await doApprove();
      expect(approved.approved).toBe(true);
      expect(existsSync(join(scratch, CHANGE_REL, 'approval.yaml'))).toBe(true);

      const implemented = await doImplement(fakeImplementSubstrate());
      expect(implemented.report.verdict).toBe('pass');

      const local = await doVerify();
      expect(local.verdict).toBe('pass');
      expect(local.checks.every((check) => check.status === 'pass')).toBe(true);

      const ci = await doCiVerify(fakeReviewer('feature/head'));
      expect(ci.verdict).toBe('pass');
      expect(ci.tier?.computed).toBe('standard');
      expect(ci.checks.map((check) => check.name)).toEqual([
        'traceability',
        'diff-cap',
        'oracles',
        'review',
        'approval',
      ]);
      expect(ci.checks.every((check) => check.status === 'pass')).toBe(true);
    },
  );

  it(
    'post-approval oracle edit stays red while the real JUnit oracle passes',
    { timeout: 600_000 },
    async () => {
      expect(HAS_JVM, 'P3-08 acceptance requires Java and Maven').toBe(true);
      await doPropose(new FakeSubstrate({ files: cannedProposal() }));
      await doApprove();
      writeFileSync(join(scratch, APP_REL), implementedGreetingSource());
      appendFileSync(join(scratch, ORACLES_REL), '\n<!-- edited after approval -->\n');

      const report = await doVerify();

      expect(report.verdict).toBe('fail');
      expect(report.checks.find((check) => check.name === 'oracles')?.status).toBe('pass');
      const approval = report.checks.find((check) => check.name === 'approval')!;
      expect(approval.status).toBe('fail');
      expect(approval.findings.some((finding) => finding.id === ORACLES_REL)).toBe(true);
    },
  );

  it(
    'a skipped JUnit oracle target stays red and does not void the seal',
    { timeout: 600_000 },
    async () => {
      expect(HAS_JVM, 'P3-08 acceptance requires Java and Maven').toBe(true);
      const proposed = await doPropose(new FakeSubstrate({ files: cannedProposal(true) }));
      expect(proposed.report.verdict).toBe('pass');
      await doApprove();

      const report = await doVerify();

      expect(report.verdict).toBe('fail');
      const oracles = report.checks.find((check) => check.name === 'oracles')!;
      expect(oracles.status).toBe('fail');
      expect(oracles.findings[0]?.message).toContain(`${TARGET}=skip`);
      expect(report.checks.find((check) => check.name === 'approval')?.status).toBe('pass');
    },
  );
});

describe.runIf(REAL)('P3-08 Spring Boot loop (real substrate, manual)', () => {
  it(
    'runs the same consumer flow green with the selected live provider',
    { timeout: 1_800_000 },
    async () => {
      expect(HAS_JVM, 'P3-08 manual run requires Java and Maven').toBe(true);
      console.log(`P3-08 real-substrate scratch repo (kept for inspection): ${scratch}`);
      const substrate = liveSubstrate();

      const proposed = await doPropose(substrate);
      expect(proposed.report.verdict).toBe('pass');
      expect((await doApprove()).approved).toBe(true);
      expect((await doImplement(substrate)).report.verdict).toBe('pass');
      expect((await doVerify()).verdict).toBe('pass');

      git(['add', '.']);
      git([
        '-c',
        'user.name=Crucible P3-08',
        '-c',
        'user.email=p3-08@example.com',
        'commit',
        '-qm',
        'Implement greet-world',
      ]);
      const head = gitText(['rev-parse', 'HEAD']);
      const ci = await doCiVerify(substrate, baselineSha, head);
      expect(ci.verdict).toBe('pass');
    },
  );
});
