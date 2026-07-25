import { join } from 'node:path';
import { loadTestsJson, VALID_BUNDLE_DIR, type StubTestEntry } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadSpecDelta, type SpecRequirement } from '../artifacts/spec-delta.js';
import { lintTraceability, type ResolveFn, type TargetResolution } from './traceability.js';

// TCB: the traceability linter is the three-way integrity gate (charter
// §Traceability Lint — Mechanics). A REQ without an oracle is a wish; an oracle
// pointing nowhere is an orphan; a binding the adapter can't collect is a broken
// pointer. Every miss must surface as a machine-readable finding naming the
// EXACT id (acceptance) so downstream verify/approve can render + block. Coverage
// here is deliberately thorough incl. fail-closed cases (CLAUDE.md test-first
// rule: correctness-critical modules require malformed-input coverage).

const VALID_SPEC_DELTA = join(VALID_BUNDLE_DIR, 'specs', 'greeting', 'spec.md');
const VALID_ORACLES = join(VALID_BUNDLE_DIR, 'oracles.md');

/**
 * Build a `resolve` with the stub adapter's semantics from a tests.json
 * inventory: an id present with a non-`missing` status → found (+targetFile);
 * an unknown id or a `missing` row → missing. Mirrors adapters/stub `resolve`
 * without importing the adapter (the linter takes `resolve` injected).
 */
function resolverFrom(inventory: readonly StubTestEntry[]): ResolveFn {
  const byId = new Map(inventory.map((e) => [e.id, e] as const));
  return (targets) =>
    Promise.resolve(
      targets.map((target): TargetResolution => {
        const row = byId.get(target);
        return row === undefined || row.status === 'missing'
          ? { target, status: 'missing' }
          : { target, status: 'found', targetFile: row.file };
      }),
    );
}

/** A resolve that claims every requested target is found (isolates set checks). */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(targets.map((target): TargetResolution => ({ target, status: 'found' })));

/** Minimal oracle factory — only the fields the linter reads. */
function oracle(id: string, requirement: string, targets: string[], line = 1): Oracle {
  return {
    id,
    title: id,
    heading: `## ${id}`,
    line,
    binding: { requirement, kind: 'unit', runner: 'stub', targets },
  };
}

/** Minimal requirement factory. */
function req(id: string, line = 1): SpecRequirement {
  return { id, title: id, line };
}

describe('lintTraceability — green on the valid toy bundle', () => {
  it('produces zero findings for the fully-traced fixture', async () => {
    const requirements = loadSpecDelta(VALID_SPEC_DELTA);
    const oracles = loadOracles(VALID_ORACLES);
    const resolve = resolverFrom(await loadTestsJson());

    const report = await lintTraceability(requirements, oracles, resolve);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('empty spec + empty oracles is trivially green', async () => {
    const report = await lintTraceability([], [], resolveAllFound);
    expect(report).toEqual({ ok: true, findings: [] });
  });
});

describe('lintTraceability — requirement-without-oracle (a wish)', () => {
  it('flags a REQ that no oracle covers, naming the exact id', async () => {
    const requirements = [req('REQ-x-covered-1'), req('REQ-x-orphaned-2', 9)];
    const oracles = [oracle('ORC-x-001', 'REQ-x-covered-1', ['t::a'])];

    const report = await lintTraceability(requirements, oracles, resolveAllFound);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.kind === 'requirement-without-oracle');
    expect(finding).toBeDefined();
    expect(finding?.id).toBe('REQ-x-orphaned-2');
    expect(finding?.line).toBe(9);
    // Machine-readable: assert on the structured id, not just prose.
    expect(report.findings.map((f) => `${f.kind}:${f.id}`)).toContain(
      'requirement-without-oracle:REQ-x-orphaned-2',
    );
  });

  it('a REQ covered by ≥1 of several oracles is NOT flagged', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [
      oracle('ORC-x-001', 'REQ-other-9', ['t::a']), // orphan, unrelated
      oracle('ORC-x-002', 'REQ-x-1', ['t::b']),
    ];
    const report = await lintTraceability(requirements, oracles, resolveAllFound);
    expect(report.findings.some((f) => f.kind === 'requirement-without-oracle')).toBe(false);
  });
});

describe('lintTraceability — orphan-oracle (points at no requirement)', () => {
  it('flags an oracle whose requirement is absent from the spec delta', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-ghost-7', ['t::a'], 4)];

    const report = await lintTraceability(requirements, oracles, resolveAllFound);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.kind === 'orphan-oracle');
    expect(finding?.id).toBe('ORC-x-001');
    expect(finding?.requirement).toBe('REQ-ghost-7');
    expect(finding?.line).toBe(4);
  });
});

describe('lintTraceability — archived-REQ index (bugfix/ratchet, design phase-2.md §1)', () => {
  it('a binding referencing an ARCHIVED requirement passes (not an orphan)', async () => {
    // A bugfix change: its own delta adds nothing here, but its reproduction oracle
    // binds an OLD requirement that lives only in the archived spec (ORC-refund-013
    // → REQ-payments-refund-4). With the archived index supplied, this is legal.
    const requirements: SpecRequirement[] = [];
    const oracles = [oracle('ORC-refund-013', 'REQ-payments-refund-4', ['t::repro'])];
    const archived = new Set(['REQ-payments-refund-4']);

    const report = await lintTraceability(requirements, oracles, resolveAllFound, archived);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('a binding referencing an UNARCHIVED unknown requirement still fails as an orphan', async () => {
    const oracles = [oracle('ORC-x-001', 'REQ-never-existed-9', ['t::a'], 7)];
    const archived = new Set(['REQ-payments-refund-4']); // does not contain the id

    const report = await lintTraceability([], oracles, resolveAllFound, archived);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.kind === 'orphan-oracle');
    expect(finding?.id).toBe('ORC-x-001');
    expect(finding?.requirement).toBe('REQ-never-existed-9');
    expect(finding?.line).toBe(7);
  });

  it('the delta still dominates: an id in the delta needs no archived entry', async () => {
    const report = await lintTraceability(
      [req('REQ-x-1')],
      [oracle('ORC-x-001', 'REQ-x-1', ['t::a'])],
      resolveAllFound,
      new Set(), // empty archive
    );
    expect(report.ok).toBe(true);
  });
});

describe('lintTraceability — unresolved-binding (broken pointer)', () => {
  it('flags a binding whose target the adapter cannot collect, naming id + target', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-x-1', ['t::gone'])];
    const resolve = resolverFrom([]); // nothing collects

    const report = await lintTraceability(requirements, oracles, resolve);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.kind === 'unresolved-binding');
    expect(finding?.id).toBe('ORC-x-001');
    expect(finding?.target).toBe('t::gone');
  });

  it('flags EACH unresolved target of a multi-target binding independently', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-x-1', ['t::here', 't::gone'])];
    const resolve = resolverFrom([{ id: 't::here', file: 'a.ts', status: 'pass' }]);

    const report = await lintTraceability(requirements, oracles, resolve);

    const unresolved = report.findings.filter((f) => f.kind === 'unresolved-binding');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.target).toBe('t::gone');
  });

  it('treats a `missing`-status row as unresolved (fail-closed)', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-x-1', ['t::m'])];
    const resolve = resolverFrom([{ id: 't::m', file: 'a.ts', status: 'missing' }]);

    const report = await lintTraceability(requirements, oracles, resolve);
    expect(
      report.findings.some((f) => f.kind === 'unresolved-binding' && f.target === 't::m'),
    ).toBe(true);
  });
});

describe('lintTraceability — fail-closed & determinism (TCB)', () => {
  it('treats a target absent from the resolve response as unresolved', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-x-1', ['t::a'])];
    // A misbehaving resolver that drops a requested target must not pass silently.
    const dropping: ResolveFn = () => Promise.resolve([]);

    const report = await lintTraceability(requirements, oracles, dropping);
    expect(
      report.findings.some((f) => f.kind === 'unresolved-binding' && f.target === 't::a'),
    ).toBe(true);
  });

  it('resolves the deduped target universe exactly once', async () => {
    const requirements = [req('REQ-x-1'), req('REQ-x-2')];
    const oracles = [
      oracle('ORC-x-001', 'REQ-x-1', ['t::shared']),
      oracle('ORC-x-002', 'REQ-x-2', ['t::shared']),
    ];
    const calls: string[][] = [];
    const resolve: ResolveFn = (targets) => {
      calls.push([...targets]);
      return Promise.resolve(targets.map((t) => ({ target: t, status: 'found' as const })));
    };

    await lintTraceability(requirements, oracles, resolve);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['t::shared']); // deduped
  });

  it('does not spawn the resolver when there are no targets', async () => {
    let called = false;
    const resolve: ResolveFn = (targets) => {
      called = true;
      return Promise.resolve(targets.map((t) => ({ target: t, status: 'found' as const })));
    };
    await lintTraceability([req('REQ-x-1')], [], resolve);
    expect(called).toBe(false);
  });

  it('is deterministic: identical inputs → identical findings ordering', async () => {
    const requirements = [req('REQ-a-1', 2), req('REQ-b-2', 5)];
    const oracles = [
      oracle('ORC-a-001', 'REQ-ghost-1', ['t::gone'], 3),
      oracle('ORC-b-001', 'REQ-b-2', ['t::gone'], 7),
    ];
    const resolve = resolverFrom([]);

    const a = await lintTraceability(requirements, oracles, resolve);
    const b = await lintTraceability(requirements, oracles, resolve);
    expect(a).toEqual(b);
    // Findings grouped by check, each in source order: coverage, orphan, binding.
    expect(a.findings.map((f) => f.kind)).toEqual([
      'requirement-without-oracle', // REQ-a-1
      'orphan-oracle', // ORC-a-001
      'unresolved-binding', // ORC-a-001 t::gone
      'unresolved-binding', // ORC-b-001 t::gone
    ]);
  });

  it('one oracle can trigger both an orphan and an unresolved finding', async () => {
    const requirements = [req('REQ-x-1')];
    const oracles = [oracle('ORC-x-001', 'REQ-ghost-9', ['t::gone'])];
    const report = await lintTraceability(requirements, oracles, resolverFrom([]));
    expect(report.findings.some((f) => f.kind === 'orphan-oracle')).toBe(true);
    expect(report.findings.some((f) => f.kind === 'unresolved-binding')).toBe(true);
  });
});
