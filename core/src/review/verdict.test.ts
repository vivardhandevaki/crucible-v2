import { describe, expect, it } from 'vitest';
import { parseRubric, type Rubric } from './rubric.js';
import { evaluateVerdict, type Finding, type Verdict } from './verdict.js';

// The verdict is the adversarial reviewer's machine-parseable output (charter
// §"Verdict Schema & the Enumerated-Blocking Rule"; design phase-2.md §5). The
// evaluator is the deterministic gate the nondeterministic reviewer stands on:
// it decides pass/fail from the verdict + the pinned rubric. Its defining rule is
// that a MALFORMED verdict is a reviewer BLOCK, not an exit-3 tool error — it
// returns a `fail` outcome, never throws (charter §528 "malformed → fail";
// invariant 9 enumerated-blocking; the reviewer may not invent rules).

// A rubric with a block line (R-001) and an advise line (R-010) — enough to prove
// enumerated-blocking is gated on the LINE's policy severity, not the finding's.
const RUBRIC: Rubric = parseRubric(
  `version: 1
lines:
  - id: R-001
    severity: block
    criterion: block rule
    evidence: some observable evidence
  - id: R-010
    severity: advise
    criterion: advise rule
    evidence: some observable evidence
`,
  'rubric.yaml',
);

const EVIDENCE = { file: 'src/pay.ts', line: 42, excerpt: 'if (x)' };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    rubric: 'R-001',
    severity: 'block',
    evidence: EVIDENCE,
    explanation: 'why',
    remediation: 'do this',
    ...over,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    change: 'partial-refunds',
    reviewed_sha: '9f3ab21',
    rubric_hash: 'sha256:abc',
    model: 'claude-x',
    verdict: 'pass',
    findings: [],
    observations: [],
    ...over,
  };
}

const json = (v: Verdict): string => JSON.stringify(v);

describe('evaluateVerdict — passing paths', () => {
  it('a clean pass verdict passes and surfaces observations', () => {
    const v = verdict({ observations: [{ note: 'idempotency untested — candidate oracle' }] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('pass');
    expect(out.observations).toEqual([{ note: 'idempotency untested — candidate oracle' }]);
  });

  it('a fail with one block finding on a block line fails, finding listed as blocking', () => {
    const v = verdict({ verdict: 'fail', findings: [finding()] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.blockingFindings.map((f) => f.rubric)).toEqual(['R-001']);
  });
});

describe('evaluateVerdict — enumerated-blocking is gated on the rubric line severity', () => {
  it('a block-severity finding citing an advise line does NOT block (becomes an observation)', () => {
    // verdict:pass keeps this a consistency-clean input; the advise-line finding
    // is non-blocking regardless of the finding's own severity (policy wins).
    const v = verdict({ findings: [finding({ rubric: 'R-010', severity: 'block' })] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('pass');
    expect(out.observations.some((o) => o.note.includes('R-010'))).toBe(true);
  });
});

describe('evaluateVerdict — fail-closed rules (each a named/flagged rule)', () => {
  it('a missing verdict file fails (no verdict is another malformed verdict)', () => {
    const out = evaluateVerdict({ text: undefined, rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('NO_VERDICT');
  });

  it('malformed JSON fails', () => {
    const out = evaluateVerdict({ text: '{not json', rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('MALFORMED_VERDICT');
  });

  it('a schema-invalid verdict fails (unknown key, strict)', () => {
    const out = evaluateVerdict({
      text: JSON.stringify({ ...verdict(), sneaky: 1 }),
      rubric: RUBRIC,
    });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('MALFORMED_VERDICT');
  });

  it('a finding citing an unknown rubric id fails (the reviewer may not invent rules)', () => {
    const v = verdict({ verdict: 'fail', findings: [finding({ rubric: 'R-999' })] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('UNKNOWN_RUBRIC_ID');
  });

  it('verdict:fail with zero blocking findings fails (inconsistent)', () => {
    const v = verdict({ verdict: 'fail', findings: [] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('INCONSISTENT_VERDICT');
  });

  it('a fail whose only finding is on an advise line is inconsistent (no real block)', () => {
    const v = verdict({
      verdict: 'fail',
      findings: [finding({ rubric: 'R-010', severity: 'block' })],
    });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('INCONSISTENT_VERDICT');
  });

  it('verdict:pass carrying a blocking finding fails (the mirror inconsistency)', () => {
    const v = verdict({ verdict: 'pass', findings: [finding()] });
    const out = evaluateVerdict({ text: json(v), rubric: RUBRIC });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('INCONSISTENT_VERDICT');
  });

  it('rubric_hash mismatch fails when the caller pins the expected hash', () => {
    const v = verdict({ verdict: 'fail', findings: [finding()], rubric_hash: 'sha256:stale' });
    const out = evaluateVerdict({
      text: json(v),
      rubric: RUBRIC,
      expectedRubricHash: 'sha256:fresh',
    });
    expect(out.status).toBe('fail');
    if (out.status !== 'fail') throw new Error('unreachable');
    expect(out.code).toBe('RUBRIC_HASH_MISMATCH');
  });

  it('a matching rubric_hash does not trip the mismatch rule', () => {
    const v = verdict({ rubric_hash: 'sha256:fresh' });
    const out = evaluateVerdict({
      text: json(v),
      rubric: RUBRIC,
      expectedRubricHash: 'sha256:fresh',
    });
    expect(out.status).toBe('pass');
  });
});
