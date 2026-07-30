import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterClient } from '../src/adapters/client.js';
import { loadManifest } from '../src/adapters/manifest.js';
import { approve } from '../src/commands/approve.js';
import { propose } from '../src/commands/propose.js';
import { verify } from '../src/commands/verify.js';
import { FakeSubstrate } from '../src/substrate/fake.js';

// P3-07 acceptance: a JVM propose session emits a plain, fully-qualified JUnit
// target that the real packaged adapter can resolve, and the Testcontainers
// integration oracle then passes through ordinary approve/verify machinery.
// Docker is required only for the second half; addressability remains testable
// on every machine with the JDK/Maven toolchain.

const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MONOREPO_ROOT = dirname(CORE_ROOT);
const FIXTURE = join(MONOREPO_ROOT, 'fixtures', 'conformance', 'spring-testcontainers');
const ADAPTER_ROOT = join(MONOREPO_ROOT, 'adapters', 'java-junit', 'package');
const MANIFEST_PATH = join(ADAPTER_ROOT, 'crucible-adapter.yaml');
const ADAPTER_PATH = join(ADAPTER_ROOT, 'java-junit.mjs');
const PROPOSE_PROMPT = join(CORE_ROOT, 'assets', 'context', 'propose.md');

const CHANGE = 'container-readiness';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const TEST_REL = join(
  'src',
  'test',
  'java',
  'com',
  'crucible',
  'conformance',
  'ContainerReadinessTest.java',
);
const STATE_REL = join('src', 'main', 'java', 'com', 'crucible', 'conformance', 'ReadyState.java');
const TARGET = 'com.crucible.conformance.ContainerReadinessTest#containerBackedContextIsReady';
const BUNDLE_FILES = [
  'proposal.md',
  'design.md',
  'oracles.md',
  join('specs', 'readiness', 'spec.md'),
] as const;

const HAS_JVM =
  spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('mvn', ['-v'], { encoding: 'utf8' }).status === 0;
const HAS_DOCKER = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-p3-07-'));
  cpSync(FIXTURE, scratch, { recursive: true });
  rmSync(join(scratch, CHANGE_REL), { recursive: true, force: true });
  rmSync(join(scratch, TEST_REL), { force: true });

  const statePath = join(scratch, STATE_REL);
  writeFileSync(
    statePath,
    readFileSync(statePath, 'utf8').replace('return true;', 'return false;'),
  );
  mkdirSync(join(scratch, '.crucible', 'context'), { recursive: true });
  cpSync(PROPOSE_PROMPT, join(scratch, '.crucible', 'context', 'propose.md'));
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function adapter() {
  const manifest = loadManifest(MANIFEST_PATH);
  return createAdapterClient({
    manifest,
    cwd: scratch,
    resolveExecutable: (name) =>
      name === 'crucible-adapter-java-junit'
        ? { command: process.execPath, prefixArgs: [ADAPTER_PATH] }
        : { command: name, prefixArgs: [] },
    timeoutMs: 300_000,
  });
}

function cannedProposal(): Record<string, string> {
  return Object.fromEntries(
    [...BUNDLE_FILES.map((rel) => join(CHANGE_REL, rel)), TEST_REL].map((rel) => [
      rel,
      readFileSync(join(FIXTURE, rel), 'utf8'),
    ]),
  );
}

async function proposeJvmChange() {
  const client = adapter();
  return propose(
    {
      root: scratch,
      change: CHANGE,
      intent: 'Expose readiness only after a real dependency container is available.',
      model: 'gpt-5.6-sol',
    },
    {
      substrate: new FakeSubstrate({ files: cannedProposal() }),
      scaffold: async (change, schema) => {
        const dir = join(scratch, 'openspec', 'changes', change);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.openspec.yaml'), `schema: ${schema}\ncreated: 2026-07-30\n`);
      },
      resolve: (targets) => client.resolve(targets),
      now: () => '2026-07-30T00:00:00Z',
    },
  );
}

describe('P3-07 JVM proposal addressing', () => {
  it('ships a plain integration-kind JUnit binding in the Spring fixture', () => {
    const oracles = readFileSync(join(FIXTURE, CHANGE_REL, 'oracles.md'), 'utf8');
    const test = readFileSync(join(FIXTURE, TEST_REL), 'utf8');
    expect(oracles).toContain('kind: integration');
    expect(oracles).toContain('runner: junit');
    expect(oracles).toContain(`target: ${TARGET}`);
    expect(test).toContain('@Test');
    expect(test).not.toContain('@ParameterizedTest');
  });

  it.skipIf(!HAS_JVM)(
    'propose emits a target the packaged java-junit adapter resolves',
    async () => {
      const proposed = await proposeJvmChange();
      expect(proposed.report.verdict).toBe('pass');

      await expect(adapter().resolve([TARGET])).resolves.toEqual([
        {
          target: TARGET,
          status: 'found',
          targetFile: TEST_REL,
        },
      ]);
    },
    300_000,
  );
});

describe.skipIf(!HAS_JVM || !HAS_DOCKER)('P3-07 Testcontainers oracle through verify', () => {
  it('treats the slow integration oracle as an ordinary JUnit oracle', async () => {
    const proposed = await proposeJvmChange();
    expect(proposed.report.verdict).toBe('pass');

    const client = adapter();
    const approved = await approve(
      { root: scratch, change: CHANGE, yes: true },
      {
        resolve: (targets) => client.resolve(targets),
        confirm: () => Promise.reject(new Error('confirm is unreachable under --yes')),
        now: () => '2026-07-30T00:01:00Z',
        approvedBy: () => 'p3-07@example.com',
      },
    );
    expect(approved.approved).toBe(true);

    const statePath = join(scratch, STATE_REL);
    writeFileSync(
      statePath,
      readFileSync(statePath, 'utf8').replace('return false;', 'return true;'),
    );

    const report = await verify(
      { root: scratch, change: CHANGE },
      {
        resolve: (targets) => client.resolve(targets),
        run: (oracles) => client.run(oracles),
      },
    );

    expect(report.verdict).toBe('pass');
    expect(report.checks.map((check) => check.name)).toEqual([
      'traceability',
      'oracles',
      'approval',
    ]);
  }, 600_000);
});
