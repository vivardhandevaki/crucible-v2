// verify report aggregation (charter §How Verify Executes; design phase-0-1.md
// §8). verify runs three independent checks — traceability lint, oracle run, and
// the approval-hash seal — and this module turns their results into ONE machine-
// readable `VerifyReport { change, checks: [{name, status, findings[]}], verdict }`
// whose verdict is `fail` iff any check failed.
//
// Every finding is attributed to its check (the `check` field) and names the
// EXACT subject id — a REQ/ORC id, or the sealed relpath for a hash void — so
// `verify` / `status` / CI can render and block on it. The report is validated
// against `verifyReportSchema` before it is emitted: verdict JSON is a trust
// boundary (architecture.md §4, "zod at every trust boundary: verdict JSON"), so
// an internally malformed report is a bug that fails closed rather than shipping.
//
// This module is pure and deterministic (invariant 12): it holds no I/O, spawns
// nothing, and produces the same report for the same check inputs in the same
// order. The command layer (commands/verify.ts) computes the inputs and calls the
// builders here; the render is plain terminal text (the rich surface is P2).

import { z } from 'zod';
import type { LintReport } from '../lint/traceability.js';
import type { OracleResult } from '../adapters/types.js';
import type { VerifyResult } from '../artifacts/approval.js';
import { tierDecisionSchema, type TierDecision } from '../tier/tier.js';

/** The check vocabulary, in report order. verify runs traceability → oracles →
 * approval (design §8); `bundle` (do the authored artifacts parse at all?) is
 * emitted by propose's post-session judgment (design §6), which reuses this
 * report as its verdict surface — one zod-guarded verdict shape for every
 * command that judges. */
export const CHECK_NAMES = ['bundle', 'traceability', 'diff-cap', 'oracles', 'approval'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** A check's binary outcome. `skip`/`error`/`void` all fold to `fail` upstream. */
export type CheckStatus = 'pass' | 'fail';

/** One machine-readable check finding: which check, the exact subject, a message. */
export const verifyFindingSchema = z.strictObject({
  /** Which check produced this finding (attribution). */
  check: z.enum(CHECK_NAMES),
  /** The exact subject at fault: a REQ/ORC id, or a sealed relpath (hash void). */
  id: z.string().min(1),
  /** One-line human rendering; the structured fields are the source of truth. */
  message: z.string().min(1),
});
export type VerifyFinding = z.infer<typeof verifyFindingSchema>;

/** One check's result: its name, status, and the findings that explain a fail. */
export const checkResultSchema = z.strictObject({
  name: z.enum(CHECK_NAMES),
  status: z.enum(['pass', 'fail']),
  findings: z.array(verifyFindingSchema),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

/** The merge-path decision (design phase-2.md §2): critical → human review;
 * trivial/standard green → the auto-merge path. Carried in verify's report and
 * consumed by CI's `route` job (charter §The Target-Branch Rule mechanics). */
export const routingDecisionSchema = z.strictObject({
  /** `human` iff the effective tier is critical; else `auto`. */
  decision: z.enum(['auto', 'human']),
  /** Deterministic "why" lines, tier reasons included, for status/CI display. */
  reasons: z.array(z.string().min(1)),
});
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** The whole verify verdict (design §8). Strict — an unknown field fails closed. */
export const verifyReportSchema = z.strictObject({
  /** The change being verified. */
  change: z.string().min(1),
  /** The checks that actually ran, in report order. */
  checks: z.array(checkResultSchema),
  /** `pass` iff every check passed; else `fail` (any red source blocks). */
  verdict: z.enum(['pass', 'fail']),
  /** The recomputed tier decision + the facts it rests on (design §2: "output
   * includes the facts used"). Present only when verify was given enforcement
   * config + diff facts (the authoritative CLI/CI path); a tier-less report
   * (propose's bundle judgment, an inner-loop verify) omits it. */
  tier: tierDecisionSchema.optional(),
  /** The merge-path routing derived from the tier. Present iff `tier` is. */
  routing: routingDecisionSchema.optional(),
});
export type VerifyReport = z.infer<typeof verifyReportSchema>;

/** The tier/routing extras threaded into an aggregated report (both or neither). */
export interface ReportExtras {
  tier?: TierDecision;
  routing?: RoutingDecision;
}

/**
 * Traceability check: green iff the lint is green. Each lint finding becomes a
 * report finding attributed to `traceability`, preserving the lint's exact id
 * and message (order preserved for determinism).
 */
export function traceabilityCheck(lint: LintReport): CheckResult {
  const findings = lint.findings.map((f): VerifyFinding => ({
    check: 'traceability',
    id: f.id,
    message: f.message,
  }));
  return { name: 'traceability', status: lint.ok ? 'pass' : 'fail', findings };
}

/**
 * Oracle check: green iff every joined oracle result passed. `skip`/`error` were
 * already coerced to a `fail` verdict by the adapter client (invariant 4); here
 * we surface the per-target statuses verbatim in the finding message so the trace
 * shows WHY the oracle failed. Findings follow oracle input order.
 */
export function oraclesCheck(results: readonly OracleResult[]): CheckResult {
  const findings: VerifyFinding[] = [];
  for (const result of results) {
    if (result.status !== 'pass') {
      const detail = result.targets.map((t) => `${t.target}=${t.status}`).join(', ');
      findings.push({
        check: 'oracles',
        id: result.oracleId,
        message: `oracle ${result.oracleId} for ${result.requirement} failed: ${detail}`,
      });
    }
  }
  return { name: 'oracles', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

/**
 * Diff-cap check (design phase-2.md §2; charter §Tier Definitions): green iff the
 * change fits the effective tier's diff cap. A breach is a red check → verdict
 * fail → exit 1, and the finding names the tier AND its cap (P2-03 acceptance:
 * "cap breach → exit 1 naming tier + cap") so the operator sees which ceiling was
 * hit. The tier + cap were computed upstream (the pure `tier/` module); this only
 * reports `facts.cap_exceeded`.
 */
export function diffCapCheck(decision: TierDecision): CheckResult {
  const { facts, tier } = decision;
  if (!facts.cap_exceeded) {
    return { name: 'diff-cap', status: 'pass', findings: [] };
  }
  return {
    name: 'diff-cap',
    status: 'fail',
    findings: [
      {
        check: 'diff-cap',
        id: tier,
        message: `diff ${facts.diff_lines} lines exceeds the ${tier}-tier cap of ${facts.diff_cap}`,
      },
    ],
  };
}

/**
 * Derive the merge-path routing from a tier decision (design phase-2.md §2):
 * critical → human review required; trivial/standard → the auto-merge path. The
 * reasons carry the tier's own "why" lines so a `human` routing is explainable
 * from the report alone. Pure — routing is a function of the tier, nothing else.
 */
export function routingFor(decision: TierDecision): RoutingDecision {
  const human = decision.tier === 'critical';
  const lead = human
    ? `tier ${decision.tier} → human review required`
    : `tier ${decision.tier} → auto-merge path`;
  return { decision: human ? 'human' : 'auto', reasons: [lead, ...decision.reasons] };
}

/**
 * Approval-hash check: green iff the seal is valid. A void seal lists each
 * mismatched relpath (edited or missing since approval) as a finding — the
 * exact escape class invariant 6 exists to catch. The caller only runs this when
 * an approval.yaml exists (a pre-approve verify skips it cleanly).
 */
export function approvalCheck(result: VerifyResult): CheckResult {
  if (result.valid) {
    return { name: 'approval', status: 'pass', findings: [] };
  }
  const findings = result.mismatches.map((rel): VerifyFinding => ({
    check: 'approval',
    id: rel,
    message: `sealed file ${rel} changed or is missing since approval — the hash mismatch voids the approval`,
  }));
  return { name: 'approval', status: 'fail', findings };
}

/**
 * Fold the executed checks into the final report. Verdict is `pass` iff every
 * check passed (an empty list is vacuously green — nothing promised, nothing to
 * disprove). Validated against the schema so a malformed report fails closed.
 */
export function aggregate(
  change: string,
  checks: CheckResult[],
  extras: ReportExtras = {},
): VerifyReport {
  const verdict: CheckStatus = checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
  return verifyReportSchema.parse({
    change,
    checks,
    verdict,
    ...(extras.tier ? { tier: extras.tier } : {}),
    ...(extras.routing ? { routing: extras.routing } : {}),
  });
}

/**
 * Plain terminal render (the rich surface is P2). One header line with the
 * verdict, one line per check with its status, and an indented line per finding
 * naming the exact id — enough for the implement inner loop to read machine-
 * parseable failures without `--json`. `label` names the judging command in the
 * header (`verify` by default; propose passes its own).
 */
export function renderReport(report: VerifyReport, label = 'verify'): string {
  const lines: string[] = [];
  lines.push(`${label} ${report.change}: ${report.verdict.toUpperCase()}`);
  if (report.tier) {
    lines.push(`  tier: ${report.tier.tier}`);
  }
  if (report.routing) {
    lines.push(`  routing: ${report.routing.decision}`);
  }
  for (const check of report.checks) {
    lines.push(`  [${check.status === 'pass' ? 'PASS' : 'FAIL'}] ${check.name}`);
    for (const finding of check.findings) {
      lines.push(`      ✗ ${finding.id}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}
