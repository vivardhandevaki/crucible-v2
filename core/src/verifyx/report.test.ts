import { describe, expect, it } from 'vitest';
import type { LintReport } from '../lint/traceability.js';
import type { OracleResult } from '../adapters/types.js';
import type { VerifyResult } from '../artifacts/approval.js';
import {
  aggregate,
  approvalCheck,
  diffCapCheck,
  oraclesCheck,
  regressionCheck,
  reproductionCheck,
  renderReport,
  routingFor,
  traceabilityCheck,
  verifyReportSchema,
  type CheckResult,
} from './report.js';
import type { TierDecision } from '../tier/tier.js';

// verifyx aggregates independently-computed check results into one machine-
// readable VerifyReport whose verdict is fail iff any check failed. Findings are
// attributed to their check (the `check` field) and name the exact subject id
// (REQ/ORC id or sealed relpath) so verify / status / CI can render + block on
// them. The report validates against its own zod schema — verdict JSON is a
// trust boundary (architecture.md §4).

describe('traceabilityCheck', () => {
  it('passes with no findings when the lint is green', () => {
    const lint: LintReport = { ok: true, findings: [] };
    expect(traceabilityCheck(lint)).toEqual({
      name: 'traceability',
      status: 'pass',
      findings: [],
    });
  });

  it('fails and carries each lint finding, attributed + naming the exact id', () => {
    const lint: LintReport = {
      ok: false,
      findings: [
        {
          kind: 'requirement-without-oracle',
          id: 'REQ-greeting-basic-1',
          message: 'requirement REQ-greeting-basic-1 has no oracle',
        },
        {
          kind: 'unresolved-binding',
          id: 'ORC-greeting-002',
          target: 'greeting::gone',
          message: 'oracle ORC-greeting-002 binds target greeting::gone',
        },
      ],
    };
    const check = traceabilityCheck(lint);
    expect(check.status).toBe('fail');
    expect(check.findings.map((f) => f.id)).toEqual(['REQ-greeting-basic-1', 'ORC-greeting-002']);
    expect(check.findings.every((f) => f.check === 'traceability')).toBe(true);
  });
});

describe('oraclesCheck', () => {
  const passing: OracleResult = {
    oracleId: 'ORC-greeting-001',
    requirement: 'REQ-greeting-basic-1',
    status: 'pass',
    targets: [{ target: 'greeting::a', status: 'pass' }],
  };

  it('passes when every oracle result is pass', () => {
    const check = oraclesCheck([passing]);
    expect(check).toEqual({ name: 'oracles', status: 'pass', findings: [] });
  });

  it('fails, naming the failed oracle id and surfacing the per-target statuses', () => {
    const failed: OracleResult = {
      oracleId: 'ORC-greeting-002',
      requirement: 'REQ-greeting-default-2',
      // skip→fail is already coerced by the adapter client; the target status is
      // surfaced verbatim for the trace.
      status: 'fail',
      targets: [{ target: 'greeting::b', status: 'skip' }],
    };
    const check = oraclesCheck([passing, failed]);
    expect(check.status).toBe('fail');
    expect(check.findings).toHaveLength(1);
    const [finding] = check.findings;
    expect(finding?.check).toBe('oracles');
    expect(finding?.id).toBe('ORC-greeting-002');
    expect(finding?.message).toContain('greeting::b');
    expect(finding?.message).toContain('skip');
  });
});

describe('regressionCheck', () => {
  it('an empty suite is vacuously green (nothing archived yet)', () => {
    expect(regressionCheck([])).toEqual({ name: 'regression', status: 'pass', findings: [] });
  });

  it('a broken past promise fails, attributed to `regression` and naming the oracle', () => {
    const broken: OracleResult = {
      oracleId: 'ORC-farewell-001',
      requirement: 'REQ-farewell-basic-1',
      status: 'fail',
      targets: [{ target: 'farewell::bye', status: 'fail' }],
    };
    const check = regressionCheck([broken]);
    expect(check.status).toBe('fail');
    expect(check.name).toBe('regression');
    const [finding] = check.findings;
    expect(finding?.check).toBe('regression');
    expect(finding?.id).toBe('ORC-farewell-001');
    expect(finding?.message).toContain('past promise');
  });
});

describe('reproductionCheck (bugfix red-on-base; P2-08)', () => {
  const failedOnBase: OracleResult = {
    oracleId: 'ORC-refund-013',
    requirement: 'REQ-refund-dispute-7',
    status: 'fail',
    targets: [{ target: 'refund::disputed', status: 'fail' }],
  };
  const passedOnBase: OracleResult = {
    oracleId: 'ORC-refund-013',
    requirement: 'REQ-refund-dispute-7',
    status: 'pass',
    targets: [{ target: 'refund::disputed', status: 'pass' }],
  };

  it('an empty batch is vacuously green (no reproduction oracles to run on base)', () => {
    expect(reproductionCheck([])).toEqual({ name: 'reproduction', status: 'pass', findings: [] });
  });

  it('a reproduction that FAILS on base is green — it reproduces the bug', () => {
    const check = reproductionCheck([failedOnBase]);
    expect(check).toEqual({ name: 'reproduction', status: 'pass', findings: [] });
  });

  it('a reproduction that PASSES on base is red — "does not reproduce", naming the oracle', () => {
    const check = reproductionCheck([passedOnBase]);
    expect(check.status).toBe('fail');
    expect(check.name).toBe('reproduction');
    const [finding] = check.findings;
    expect(finding?.check).toBe('reproduction');
    expect(finding?.id).toBe('ORC-refund-013');
    expect(finding?.message).toContain('does not reproduce');
    // The per-target evidence is surfaced so the trace shows WHY it is red.
    expect(finding?.message).toContain('refund::disputed=pass');
  });

  it('only the reproductions that passed on base are findings (input order preserved)', () => {
    const other: OracleResult = { ...passedOnBase, oracleId: 'ORC-refund-014' };
    const check = reproductionCheck([failedOnBase, passedOnBase, other]);
    expect(check.status).toBe('fail');
    expect(check.findings.map((f) => f.id)).toEqual(['ORC-refund-013', 'ORC-refund-014']);
  });
});

describe('approvalCheck', () => {
  it('passes when the seal is valid', () => {
    const valid: VerifyResult = { valid: true };
    expect(approvalCheck(valid)).toEqual({ name: 'approval', status: 'pass', findings: [] });
  });

  it('fails, listing each mismatched relpath as a finding attributed to approval', () => {
    const voided: VerifyResult = {
      valid: false,
      void: true,
      mismatches: ['openspec/changes/add-greeting/oracles.md', 'tests/greeting.test.ts'],
    };
    const check = approvalCheck(voided);
    expect(check.status).toBe('fail');
    expect(check.findings.map((f) => f.id)).toEqual([
      'openspec/changes/add-greeting/oracles.md',
      'tests/greeting.test.ts',
    ]);
    expect(check.findings.every((f) => f.check === 'approval')).toBe(true);
  });
});

describe('aggregate + schema', () => {
  const pass: CheckResult = { name: 'traceability', status: 'pass', findings: [] };
  const fail: CheckResult = {
    name: 'oracles',
    status: 'fail',
    findings: [{ check: 'oracles', id: 'ORC-x', message: 'x failed' }],
  };

  it('verdict is pass iff every check passed', () => {
    expect(aggregate('c', [pass]).verdict).toBe('pass');
    expect(aggregate('c', [pass, fail]).verdict).toBe('fail');
    // An empty check list (nothing to disprove) is vacuously green.
    expect(aggregate('c', []).verdict).toBe('pass');
  });

  it('preserves the change name and check order', () => {
    const report = aggregate('add-greeting', [pass, fail]);
    expect(report.change).toBe('add-greeting');
    expect(report.checks.map((c) => c.name)).toEqual(['traceability', 'oracles']);
  });

  it('every aggregated report validates against verifyReportSchema', () => {
    expect(() => verifyReportSchema.parse(aggregate('c', [pass, fail]))).not.toThrow();
    expect(() => verifyReportSchema.parse(aggregate('c', [pass]))).not.toThrow();
  });

  it('the schema is strict — an unknown field is rejected (fail-closed)', () => {
    const report = aggregate('c', [pass]) as Record<string, unknown>;
    expect(() => verifyReportSchema.parse({ ...report, sneaky: true })).toThrow();
  });
});

/** A tier decision fixture with the given effective tier and cap state. */
function tierDecision(
  tier: 'trivial' | 'standard' | 'critical',
  capExceeded: boolean,
): TierDecision {
  return {
    tier,
    computed: tier,
    forced: null,
    reasons: [`computed ${tier}`],
    facts: {
      spec_delta: tier !== 'trivial',
      risk_matches: tier === 'critical' ? [{ path: 'src/auth/x.ts', glob: 'src/**/auth/**' }] : [],
      diff_lines: capExceeded ? 500 : 40,
      diff_cap: 400,
      cap_exceeded: capExceeded,
    },
  };
}

describe('diffCapCheck', () => {
  it('passes when the diff is within the tier cap', () => {
    expect(diffCapCheck(tierDecision('standard', false))).toEqual({
      name: 'diff-cap',
      status: 'pass',
      findings: [],
    });
  });

  it('fails naming the tier and the cap on a breach (acceptance: exit 1 names tier + cap)', () => {
    const check = diffCapCheck(tierDecision('standard', true));
    expect(check.status).toBe('fail');
    expect(check.findings).toHaveLength(1);
    const [finding] = check.findings;
    expect(finding?.check).toBe('diff-cap');
    // The tier and its cap both appear in the message so the operator sees WHY.
    expect(finding?.message).toContain('standard');
    expect(finding?.message).toContain('400');
    expect(finding?.message).toContain('500');
  });
});

describe('routingFor', () => {
  it('routes a critical tier to human review', () => {
    const routing = routingFor(tierDecision('critical', false));
    expect(routing.decision).toBe('human');
    expect(routing.reasons.length).toBeGreaterThan(0);
  });

  it('routes trivial and standard tiers to the auto path', () => {
    expect(routingFor(tierDecision('standard', false)).decision).toBe('auto');
    expect(routingFor(tierDecision('trivial', false)).decision).toBe('auto');
  });
});

describe('aggregate + tier/routing extras', () => {
  const pass: CheckResult = { name: 'traceability', status: 'pass', findings: [] };

  it('threads the tier decision and routing through into the report', () => {
    const decision = tierDecision('critical', false);
    const report = aggregate('c', [pass], { tier: decision, routing: routingFor(decision) });
    expect(report.tier?.tier).toBe('critical');
    expect(report.routing?.decision).toBe('human');
    expect(() => verifyReportSchema.parse(report)).not.toThrow();
  });

  it('a report without tier/routing still validates (propose reuses this shape)', () => {
    const report = aggregate('c', [pass]);
    expect(report.tier).toBeUndefined();
    expect(report.routing).toBeUndefined();
    expect(() => verifyReportSchema.parse(report)).not.toThrow();
  });
});

describe('renderReport', () => {
  it('renders the verdict, each check status, and every finding id', () => {
    const report = aggregate('add-greeting', [
      { name: 'traceability', status: 'pass', findings: [] },
      {
        name: 'oracles',
        status: 'fail',
        findings: [{ check: 'oracles', id: 'ORC-greeting-002', message: 'oracle failed' }],
      },
    ]);
    const text = renderReport(report);
    expect(text).toContain('add-greeting');
    expect(text.toLowerCase()).toContain('fail');
    expect(text).toContain('traceability');
    expect(text).toContain('oracles');
    expect(text).toContain('ORC-greeting-002');
  });
});
