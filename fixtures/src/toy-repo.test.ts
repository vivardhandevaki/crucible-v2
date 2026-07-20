import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVALID_FIXTURES_DIR,
  loadExpectedErrors,
  loadTestsJson,
  TOY_REPO_ROOT,
  VALID_BUNDLE_DIR,
  type TestStatus,
} from './index.js';

// P0-03 smoke test: the toy fixture repo loads and is internally consistent.
//
// This is a *fixture* smoke test, not a parser. It proves the data is present,
// well-formed, and coherent enough for the downstream tasks that consume it
// (stub adapter P1-10, oracle parser P1-03, spec-delta P1-04, lint P1-05,
// hashing P1-06, the tracer P1-16). The authoritative parsers arrive later; here
// we only assert enough structure to keep the fixture honest.

async function read(...parts: string[]): Promise<string> {
  return readFile(join(...parts), 'utf8');
}

describe('toy repo — tests.json', () => {
  it('loads and validates every entry', async () => {
    const tests = await loadTestsJson();
    expect(tests.length).toBeGreaterThan(0);
    // ids are unique — they are the adapter's opaque targets.
    const ids = tests.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exercises all four normalized statuses', async () => {
    const tests = await loadTestsJson();
    const seen = new Set<TestStatus>(tests.map((t) => t.status));
    for (const status of ['pass', 'fail', 'skip', 'missing'] as const) {
      expect(seen).toContain(status);
    }
  });
});

describe('toy repo — valid change bundle', () => {
  const files = [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'oracles.md',
    'tasks.md',
    join('specs', 'greeting', 'spec.md'),
  ];

  it('has every required artifact, non-empty', async () => {
    for (const rel of files) {
      const body = await read(VALID_BUNDLE_DIR, rel);
      expect(body.trim().length, `${rel} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('is traceable: every bound target resolves and every REQ is covered', async () => {
    const oracles = await read(VALID_BUNDLE_DIR, 'oracles.md');
    const spec = await read(VALID_BUNDLE_DIR, 'specs', 'greeting', 'spec.md');
    const tests = await loadTestsJson();

    // Exactly the two oracle headings, each with one binding fence.
    const oracleHeadings = oracles.match(/^## ORC-[a-z0-9-]+-\d{3}:/gm) ?? [];
    const fences = oracles.match(/```yaml crucible-binding/g) ?? [];
    expect(oracleHeadings.length).toBe(2);
    expect(fences.length).toBe(2);

    // Every binding target exists in tests.json and is a passing test — so the
    // lint fixture is green and the tracer path succeeds.
    const targets = [...oracles.matchAll(/^target:\s*(\S+)$/gm)].map((m) => m[1]);
    expect(targets.length).toBe(2);
    for (const target of targets) {
      const entry = tests.find((t) => t.id === target);
      expect(entry, `binding target ${target} must exist in tests.json`).toBeDefined();
      expect(entry?.status).toBe('pass');
    }

    // Every REQ declared in the spec delta is referenced by ≥1 binding.
    const reqs = [...spec.matchAll(/\[(REQ-[a-z0-9-]+-\d+)\]/g)].map((m) => m[1]);
    expect(reqs.length).toBeGreaterThan(0);
    const boundReqs = new Set(
      [...oracles.matchAll(/^requirement:\s*(REQ-\S+)$/gm)].map((m) => m[1]),
    );
    for (const req of reqs) {
      expect(boundReqs, `REQ ${req} must be covered by an oracle`).toContain(req);
    }
  });
});

describe('toy repo — invalid fixtures catalogue', () => {
  it('documents each defect with an exit-3 code and an accurate locator', async () => {
    const errors = await loadExpectedErrors();
    expect(errors.length).toBeGreaterThan(0);

    for (const err of errors) {
      // Artifact grammar violations fail closed with exit code 3.
      expect(err.exitCode, `${err.id} should be exit 3`).toBe(3);

      const body = await read(TOY_REPO_ROOT, err.path);
      const lines = body.split('\n');

      // Drift guard: the documented line still holds the documented locator, and
      // the heading it lives under is really in the file. If an author edits the
      // fixture without updating the catalogue, this fails.
      expect(err.line, `${err.id} line in range`).toBeLessThanOrEqual(lines.length);
      expect(lines[err.line - 1]?.trim(), `${err.id} locator drift`).toBe(err.locator.trim());
      expect(body, `${err.id} heading missing`).toContain(err.heading);
    }
  });

  it('names at least one consumer task for every fixture', async () => {
    const errors = await loadExpectedErrors();
    for (const err of errors) {
      expect(err.consumers.length, `${err.id} needs a consumer`).toBeGreaterThan(0);
      expect(err.path.startsWith('bundles/invalid/')).toBe(true);
    }
    void INVALID_FIXTURES_DIR;
  });
});
