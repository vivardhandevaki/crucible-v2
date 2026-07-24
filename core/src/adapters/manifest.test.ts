import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_ADAPTER_MANIFEST_PATH } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { loadManifest, parseManifest } from './manifest.js';

// TCB: the manifest is the adapter's declaration of how it is spawned (charter
// §Adapter Manifest & Transport). A malformed manifest must fail closed at
// exit 3 — a client that guesses invocation strings is a bypass vector. Coverage
// is deliberately thorough incl. malformed-input cases (CLAUDE.md test-first).

function tmpManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-manifest-'));
  const path = join(dir, 'crucible-adapter.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('loadManifest — the real stub manifest', () => {
  it('loads and validates adapters/stub/crucible-adapter.yaml', () => {
    const manifest = loadManifest(STUB_ADAPTER_MANIFEST_PATH);
    expect(manifest.name).toBe('stub');
    expect(manifest.runners).toContain('stub');
    expect(manifest.capabilities).toContain('unit');
    expect(manifest.invocations.resolve).toBe('crucible-adapter-stub resolve');
    expect(manifest.invocations.run).toBe('crucible-adapter-stub run');
    // The stub omits `scope` (optional in the protocol).
    expect(manifest.invocations.scope).toBeUndefined();
  });
});

describe('parseManifest — valid shapes', () => {
  it('accepts a manifest with a scope invocation', () => {
    const manifest = parseManifest(
      [
        'name: py',
        'version: 1.0.0',
        'runners: [pytest]',
        'capabilities: [unit, property, scope]',
        'invocations:',
        '  resolve: "crucible-adapter-pytest resolve"',
        '  run: "crucible-adapter-pytest run"',
        '  scope: "crucible-adapter-pytest scope"',
      ].join('\n'),
      'test',
    );
    expect(manifest.invocations.scope).toBe('crucible-adapter-pytest scope');
  });
});

describe('parseManifest — fail-closed (exit 3) on malformed input', () => {
  const cases: { name: string; body: string }[] = [
    { name: 'not valid YAML', body: 'name: [unterminated' },
    { name: 'not an object (a bare list)', body: '- a\n- b' },
    {
      name: 'missing name',
      body: 'version: 1.0.0\nrunners: [stub]\ncapabilities: [unit]\ninvocations:\n  resolve: "a resolve"\n  run: "a run"',
    },
    {
      name: 'missing invocations.run',
      body: 'name: x\nversion: 1.0.0\nrunners: [stub]\ncapabilities: [unit]\ninvocations:\n  resolve: "a resolve"',
    },
    {
      name: 'empty runners array',
      body: 'name: x\nversion: 1.0.0\nrunners: []\ncapabilities: [unit]\ninvocations:\n  resolve: "a resolve"\n  run: "a run"',
    },
    {
      name: 'unknown top-level key (typo must not silently no-op)',
      body: 'name: x\nversion: 1.0.0\nrunners: [stub]\ncapabilities: [unit]\nrunnerz: [stub]\ninvocations:\n  resolve: "a resolve"\n  run: "a run"',
    },
    {
      name: 'invocation is not a string',
      body: 'name: x\nversion: 1.0.0\nrunners: [stub]\ncapabilities: [unit]\ninvocations:\n  resolve: 42\n  run: "a run"',
    },
  ];

  for (const { name, body } of cases) {
    it(`${name} → exit 3`, () => {
      let thrown: unknown;
      try {
        parseManifest(body, 'test');
      } catch (err) {
        thrown = err;
      }
      expect(isCrucibleError(thrown)).toBe(true);
      if (isCrucibleError(thrown)) expect(thrown.exit).toBe(3);
    });
  }
});

describe('loadManifest — missing file', () => {
  it('fails closed (exit 2 precondition) when the manifest is absent', () => {
    let thrown: unknown;
    try {
      loadManifest(tmpManifest('').replace('crucible-adapter.yaml', 'nope.yaml'));
    } catch (err) {
      thrown = err;
    }
    expect(isCrucibleError(thrown)).toBe(true);
    if (isCrucibleError(thrown)) expect(thrown.exit).toBe(2);
  });
});
