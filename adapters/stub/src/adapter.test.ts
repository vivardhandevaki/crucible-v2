// Unit tests for the pure adapter logic (parsing + mapping). The wire/spawn
// surface is covered by cli.test.ts; here we exercise the mapping and the
// fail-closed parsers directly, including malformed inputs (TCB coverage).

import { describe, expect, it } from 'vitest';
import {
  parseInventory,
  parseRequest,
  resolve,
  run,
  WireError,
  type StubTestEntry,
} from './adapter.js';

const INVENTORY: StubTestEntry[] = [
  { id: 'a::pass', file: 'tests/a.test.ts', status: 'pass' },
  { id: 'a::fail', file: 'tests/a.test.ts', status: 'fail', message: 'boom' },
  { id: 'b::skip', file: 'tests/b.test.ts', status: 'skip', message: 'skipped' },
  { id: 'b::gone', file: 'tests/b.test.ts', status: 'missing' },
];

describe('resolve', () => {
  it('maps known id → found with targetFile', () => {
    expect(resolve(['a::pass'], INVENTORY)).toEqual([
      { target: 'a::pass', status: 'found', targetFile: 'tests/a.test.ts' },
    ]);
  });

  it('maps unknown id and missing-status row → missing without targetFile', () => {
    expect(resolve(['nope', 'b::gone'], INVENTORY)).toEqual([
      { target: 'nope', status: 'missing' },
      { target: 'b::gone', status: 'missing' },
    ]);
  });

  it('preserves input order and cardinality', () => {
    const out = resolve(['a::fail', 'nope', 'a::pass'], INVENTORY);
    expect(out.map((r) => r.target)).toEqual(['a::fail', 'nope', 'a::pass']);
  });

  it('empty targets → empty results', () => {
    expect(resolve([], INVENTORY)).toEqual([]);
  });
});

describe('run', () => {
  it('passes pass/fail/skip through and carries message', () => {
    expect(run(['a::pass', 'a::fail', 'b::skip'], INVENTORY)).toEqual([
      { target: 'a::pass', status: 'pass' },
      { target: 'a::fail', status: 'fail', message: 'boom' },
      { target: 'b::skip', status: 'skip', message: 'skipped' },
    ]);
  });

  it('never maps skip → fail (that is core downstream, invariant #4)', () => {
    expect(run(['b::skip'], INVENTORY)[0]!.status).toBe('skip');
  });

  it('unknown target → error (fail-closed, not dropped)', () => {
    const out = run(['ghost'], INVENTORY);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('error');
    expect(out[0]!.message).toContain('ghost');
  });

  it('missing-status row → error', () => {
    expect(run(['b::gone'], INVENTORY)[0]!.status).toBe('error');
  });
});

describe('parseRequest — fail-closed', () => {
  it('accepts a well-formed body', () => {
    expect(parseRequest(JSON.stringify({ targets: ['x'] }))).toEqual(['x']);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseRequest('{')).toThrow(WireError);
  });

  it('rejects a missing targets array', () => {
    expect(() => parseRequest(JSON.stringify({ nope: 1 }))).toThrow(/targets/);
  });

  it('rejects a non-string target entry', () => {
    expect(() => parseRequest(JSON.stringify({ targets: [1] }))).toThrow(WireError);
  });
});

describe('parseInventory — fail-closed', () => {
  it('parses a valid inventory', () => {
    const raw = JSON.stringify([{ id: 'x', file: 'f', status: 'pass' }]);
    expect(parseInventory(raw, 't.json')).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseInventory('nope', 't.json')).toThrow(/valid JSON/);
  });

  it('rejects a non-array top level', () => {
    expect(() => parseInventory('{}', 't.json')).toThrow(/array/);
  });

  it('rejects an unknown status', () => {
    const raw = JSON.stringify([{ id: 'x', file: 'f', status: 'weird' }]);
    expect(() => parseInventory(raw, 't.json')).toThrow(/status/);
  });

  it('rejects a row with no id', () => {
    const raw = JSON.stringify([{ file: 'f', status: 'pass' }]);
    expect(() => parseInventory(raw, 't.json')).toThrow(/id/);
  });
});
