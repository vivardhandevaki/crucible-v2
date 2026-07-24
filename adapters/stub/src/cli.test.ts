// Wire-protocol conformance tests. These SPAWN the built executable
// (dist/cli.js) and feed JSON on stdin — the stub is an executable, not a
// library, so it is exercised as the wire protocol the core client will speak.
//
// The golden cases come from fixtures/conformance/ (seeded by this task): a set
// of (verb + input → expected normalized output) pairs any adapter must satisfy.

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_CASES_PATH,
  TESTS_JSON_PATH,
  loadConformanceCases,
  type ConformanceCase,
} from '@crucible/fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const stubRoot = dirname(here); // adapters/stub
const CLI = join(stubRoot, 'dist', 'cli.js');

beforeAll(() => {
  // The tests drive the compiled executable, so build it first. Deterministic:
  // tsc from the workspace's own tsconfig, no wall-clock inputs.
  execFileSync('npx', ['tsc'], { cwd: stubRoot, stdio: 'inherit' });
});

interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnStub(args: string[], stdin: string): Spawned {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runVerb(verb: string, targets: string[]): Spawned {
  return spawnStub([verb, '--tests', TESTS_JSON_PATH], JSON.stringify({ targets }));
}

describe('stub adapter — conformance seed', () => {
  let cases: ConformanceCase[];

  beforeAll(async () => {
    cases = await loadConformanceCases();
  });

  it('seeds fixtures/conformance/ with a non-empty golden set', () => {
    expect(CONFORMANCE_CASES_PATH).toContain('conformance');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.verb === 'resolve')).toBe(true);
    expect(cases.some((c) => c.verb === 'run')).toBe(true);
  });

  it('satisfies every golden conformance case (verb + input → normalized output)', () => {
    for (const c of cases) {
      const { status, stdout, stderr } = runVerb(c.verb, c.targets);
      expect(status, `case ${c.name}: stderr=${stderr}`).toBe(0);
      const parsed = JSON.parse(stdout) as { results: unknown[] };
      expect(parsed.results, `case ${c.name}`).toEqual(c.expected);
    }
  });
});

describe('stub adapter — resolve schema', () => {
  it('emits found + targetFile for a known id', () => {
    const { status, stdout } = runVerb('resolve', ['greeting::returns_hello_for_a_name']);
    expect(status).toBe(0);
    const { results } = JSON.parse(stdout) as { results: Array<Record<string, unknown>> };
    expect(results).toEqual([
      {
        target: 'greeting::returns_hello_for_a_name',
        status: 'found',
        targetFile: 'tests/greeting.test.ts',
      },
    ]);
    // targetFile is the KEY the core client relies on so it never parses targets.
    expect(results[0]).toHaveProperty('targetFile');
  });

  it('emits missing (no targetFile) for an unknown id and for a missing-status row', () => {
    const { results } = JSON.parse(
      runVerb('resolve', ['greeting::no_such_test', 'greeting::streams_large_input']).stdout,
    ) as { results: Array<Record<string, unknown>> };
    expect(results).toEqual([
      { target: 'greeting::no_such_test', status: 'missing' },
      { target: 'greeting::streams_large_input', status: 'missing' },
    ]);
    for (const r of results) expect(r).not.toHaveProperty('targetFile');
  });
});

describe('stub adapter — run schema (charter normalized result)', () => {
  const NORMALIZED_STATUSES = new Set(['pass', 'fail', 'error', 'skip']);

  it('passes pass/fail/skip through verbatim and never maps skip→fail', () => {
    const { results } = JSON.parse(
      runVerb('run', [
        'greeting::returns_hello_for_a_name',
        'greeting::rejects_null_bytes',
        'greeting::is_localized',
      ]).stdout,
    ) as { results: Array<Record<string, unknown>> };
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'skip']);
    // skip must survive as skip: the skip→fail mapping is CORE's job (invariant #4).
    expect(results[2]).toMatchObject({ status: 'skip' });
    // fail carries its message.
    expect(results[1]).toMatchObject({ status: 'fail' });
    expect(typeof results[1]!.message).toBe('string');
  });

  it('reports error for a target with no row (fail-closed, not dropped)', () => {
    const { results } = JSON.parse(runVerb('run', ['greeting::no_such_test']).stdout) as {
      results: Array<Record<string, unknown>>;
    };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'error' });
  });

  it('only ever emits statuses in the charter enum', () => {
    const { results } = JSON.parse(
      runVerb('run', [
        'greeting::returns_hello_for_a_name',
        'greeting::rejects_null_bytes',
        'greeting::is_localized',
        'greeting::streams_large_input',
        'greeting::no_such_test',
      ]).stdout,
    ) as { results: Array<Record<string, unknown>> };
    for (const r of results) expect(NORMALIZED_STATUSES.has(r.status as string)).toBe(true);
  });
});

describe('stub adapter — fail-closed wire errors (invariant #3)', () => {
  it('malformed JSON on stdin → non-zero exit + stderr', () => {
    const { status, stderr } = spawnStub(['run', '--tests', TESTS_JSON_PATH], 'not json{');
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/valid JSON/i);
  });

  it('a JSON body without a targets array → non-zero exit', () => {
    const { status, stderr } = spawnStub(
      ['run', '--tests', TESTS_JSON_PATH],
      JSON.stringify({ nope: [] }),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/targets/i);
  });

  it('a non-string entry in targets → non-zero exit', () => {
    const { status } = spawnStub(
      ['resolve', '--tests', TESTS_JSON_PATH],
      JSON.stringify({ targets: ['ok', 42] }),
    );
    expect(status).not.toBe(0);
  });

  it('missing verb → non-zero exit + stderr', () => {
    const { status, stderr } = spawnStub(
      ['--tests', TESTS_JSON_PATH],
      JSON.stringify({ targets: [] }),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/verb/i);
  });

  it('unknown verb → non-zero exit', () => {
    const { status } = spawnStub(
      ['detonate', '--tests', TESTS_JSON_PATH],
      JSON.stringify({ targets: [] }),
    );
    expect(status).not.toBe(0);
  });

  it('unreadable tests file → non-zero exit', () => {
    const { status, stderr } = spawnStub(
      ['run', '--tests', join(stubRoot, 'no-such-tests.json')],
      JSON.stringify({ targets: [] }),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/tests file/i);
  });
});
