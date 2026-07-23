import { describe, expect, it } from 'vitest';
import type { LintReport } from '../lint/traceability.js';
import type { OracleResult } from '../adapters/types.js';
import type { VerifyResult } from '../artifacts/approval.js';
import {
  aggregate,
  approvalCheck,
  oraclesCheck,
  renderReport,
  traceabilityCheck,
  verifyReportSchema,
  type CheckResult,
} from './report.js';

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
