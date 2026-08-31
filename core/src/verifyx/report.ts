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
import type { VerdictOutcome } from '../review/verdict.js';
import { tierDecisionSchema, type TierDecision } from '../tier/tier.js';

/** The check vocabulary, in report order. verify runs traceability → oracles →
 * approval (design §8); `bundle` (do the authored artifacts parse at all?) is
 * emitted by propose's post-session judgment (design §6), which reuses this
 * report as its verdict surface — one zod-guarded verdict shape for every
 * command that judges. */
export const CHECK_NAMES = [
  'bundle',
  'traceability',
  'diff-cap',
  'oracles',
  'regression',
  'suites',
  'reproduction',
  'review',
  'approval',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** A check's binary outcome. `skip`/`error`/`void` all fold to `fail` upstream. */
export type CheckStatus = 'pass' | 'fail';

/** Process outcome for one configured ordinary suite (unit/build/lint/typecheck). */
export interface DeclaredSuiteResult {
  name: string;
  status: CheckStatus;
  message?: string;
}

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
  /** `human` iff the effective tier is critical OR an override is present; else `auto`. */
  decision: z.enum(['auto', 'human']),
  /** Deterministic "why" lines, tier reasons included, for status/CI display. */
  reasons: z.array(z.string().min(1)),
});
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** The ratchet issue CI files when an override bypassed the gate (charter §Override;
 * design phase-2.md §3). Core emits the payload inside the report JSON; the CI-
 * template step files it idempotently via the ambient GITHUB_TOKEN — no token
 * plumbing in core (invariant 11: convenience never enforcement). */
export const ratchetIssueSchema = z.strictObject({
  /** Issue title — NAMES the change so CI can search for a duplicate before filing. */
  title: z.string().min(1),
  /** Issue body — reason + who/when + the closing condition (a retroactive proposal). */
  body: z.string().min(1),
  /** Labels applied; includes `crucible-override`, the label CI searches by. */
  labels: z.array(z.string().min(1)).nonempty(),
});
export type RatchetIssue = z.infer<typeof ratchetIssueSchema>;

/** The override record surfaced in a verify report (design phase-2.md §3): WHY the
 * gate was bypassed and the ratchet issue CI must file. Its presence forces the
 * verdict to `pass` (the bypass is permitted) and routing to `human` regardless of
 * tier — loud, never quiet (charter row 5: visibility replaces prohibition). */
export const overrideReportSchema = z.strictObject({
  /** The human's stated reason for the bypass (from override.yaml). */
  reason: z.string().min(1),
  /** The ratchet issue payload CI files idempotently. */
  issue: ratchetIssueSchema,
});
export type OverrideReport = z.infer<typeof overrideReportSchema>;

/** The adversarial-reviewer record carried on a verify report (P2-10; charter
 * §Verdict Schema; design phase-2.md §5). Present iff the review check ran.
 * `rubric_hash` is the hash of the law the review was adjudicated against —
 * computed by CORE from .crucible/rubric.yaml, never taken from the verdict.
 * `model` is the verdict's self-declared reviewer identity (the v2.0-light drift
 * guard: pinned for audit, not enforcement — absent when no verdict parsed).
 * `observations` is the harvest channel (charter §530): everything the reviewer
 * noticed that is NOT a rubric line, attached to the report so CI can surface it
 * on the PR — promotable to rubric lines by humans, never a block. */
export const reviewReportSchema = z.strictObject({
  rubric_hash: z.string().min(1),
  model: z.string().min(1).optional(),
  observations: z.array(z.strictObject({ note: z.string().min(1) })),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

/** The trajectory stamp carried on a verify report (P2-11; charter §278; design
 * phase-2.md §6 — "Trajectory capture (checks parked)"). Present only on the
 * authoritative CI path when `trajectory.require_local_verify` is set. It records
 * whether a local verify ran before push (`local_verify_ran`, derived from the
 * change's state events) plus any `advisories`. Deterministic trajectory *checks*
 * are parked (backlog C17) — every advisory here is ADVISE-LEVEL: surfaced, never
 * a block. Nothing in this section moves the verdict (invariant 11). */
export const trajectoryReportSchema = z.strictObject({
  /** Was a local verify recorded in state before push? (charter §278.) */
  local_verify_ran: z.boolean(),
  /** Non-blocking advisories (parked-check harvest): a machine `code` + message.
   * Empty when the trajectory looks clean. Never blocks the merge. */
  advisories: z.array(z.strictObject({ code: z.string().min(1), message: z.string().min(1) })),
});
export type TrajectoryReport = z.infer<typeof trajectoryReportSchema>;

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
  /** The 2am escape hatch (design §3). Present iff an override.yaml is in the
   * bundle: the verdict is forced `pass` (bypass permitted) and routing forced
   * `human`. Its `issue` is the ratchet payload CI files. Absent on the common
   * path — an override is the loud exception, not the rule. */
  override: overrideReportSchema.optional(),
  /** The adversarial-reviewer record (P2-10). Present iff the review check ran
   * (CI always; locally only under `verify --review`) — carries the pinned
   * rubric hash, the reviewing model, and the PR-bound observations. */
  review: reviewReportSchema.optional(),
  /** The trajectory stamp (P2-11). Present only on the authoritative path when
   * `trajectory.require_local_verify` is set. Advise-level — never a block. */
  trajectory: trajectoryReportSchema.optional(),
});
export type VerifyReport = z.infer<typeof verifyReportSchema>;

/** The tier/routing/override/review extras threaded into an aggregated report.
 * `tier` and `routing` travel together (both or neither); the rest are independent. */
export interface ReportExtras {
  tier?: TierDecision;
  routing?: RoutingDecision;
  override?: OverrideReport;
  review?: ReviewReport;
  trajectory?: TrajectoryReport;
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
 * Regression check (charter §The Regression Suite; design phase-2.md §1): green
 * iff every ARCHIVED oracle re-run by verify still passes. Structurally identical
 * to `oraclesCheck` — same joined `OracleResult` shape, same skip→fail coercion
 * already applied by the client — but attributed to `regression` so the report
 * distinguishes a broken PAST promise (a refactor that changed pinned behavior)
 * from a failing current-change oracle. Findings follow oracle input order. An
 * empty suite (nothing archived yet) is vacuously green.
 */
export function regressionCheck(results: readonly OracleResult[]): CheckResult {
  const findings: VerifyFinding[] = [];
  for (const result of results) {
    if (result.status !== 'pass') {
      const detail = result.targets.map((t) => `${t.target}=${t.status}`).join(', ');
      findings.push({
        check: 'regression',
        id: result.oracleId,
        message: `regression oracle ${result.oracleId} for ${result.requirement} failed: ${detail} — a past promise no longer holds`,
      });
    }
  }
  return { name: 'regression', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

/**
 * Turn configured ordinary-suite outcomes into one attributable check. Unknown,
 * duplicated, omitted, or malformed results are red rather than silently
 * skipping a declared suite.
 */
export function suitesCheck(
  declared: Record<string, string>,
  results: readonly DeclaredSuiteResult[],
): CheckResult {
  const expected = Object.keys(declared).sort();
  const findings: VerifyFinding[] = [];
  const byName = new Map<string, DeclaredSuiteResult>();
  for (const result of results) {
    if (
      typeof result?.name !== 'string' ||
      result.name.length === 0 ||
      (result.status !== 'pass' && result.status !== 'fail') ||
      (result.message !== undefined && typeof result.message !== 'string')
    ) {
      findings.push({
        check: 'suites',
        id: 'suite-output',
        message: 'suite runner returned malformed output',
      });
      continue;
    }
    if (!Object.hasOwn(declared, result.name)) {
      findings.push({
        check: 'suites',
        id: result.name,
        message: `suite runner returned undeclared suite ${result.name}`,
      });
      continue;
    }
    if (byName.has(result.name)) {
      findings.push({
        check: 'suites',
        id: result.name,
        message: `suite runner returned duplicate result for ${result.name}`,
      });
      continue;
    }
    byName.set(result.name, result);
  }
  for (const name of expected) {
    const result = byName.get(name);
    if (!result) {
      findings.push({ check: 'suites', id: name, message: `suite ${name} returned no result` });
    } else if (result.status === 'fail') {
      findings.push({
        check: 'suites',
        id: name,
        message: `suite ${name} failed${result.message ? `: ${result.message}` : ''}`,
      });
    }
  }
  return { name: 'suites', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

/**
 * Reproduction check (charter §Change Types L251; design phase-2.md §4): the
 * RED-ON-BASE half of a bugfix's red-on-base/green-on-fix rule. Its input is the
 * result of running the bugfix's reproduction oracles against the MERGE-BASE
 * checkout (the pre-fix source, with the new tests carried onto it). On base the
 * bug is still present, so every reproduction oracle is EXPECTED to fail (a
 * non-`pass` — including an `error`/`skip` the client already coerced to fail — is
 * the correct outcome there: a reproduction that cannot even run against the old
 * source has still not passed). An oracle that PASSES on base does not reproduce
 * the bug at all, and that is the red — exit 1, "does not reproduce". The
 * GREEN-ON-FIX half is the ordinary `oracles` check against HEAD (the reproduction
 * oracles run there like any other). Findings follow oracle input order; an empty
 * input (no reproduction oracles) is vacuously green.
 */
export function reproductionCheck(baseResults: readonly OracleResult[]): CheckResult {
  const findings: VerifyFinding[] = [];
  for (const result of baseResults) {
    if (result.status === 'pass') {
      const detail = result.targets.map((t) => `${t.target}=${t.status}`).join(', ');
      findings.push({
        check: 'reproduction',
        id: result.oracleId,
        message: `reproduction oracle ${result.oracleId} for ${result.requirement} PASSES on the merge-base (${detail}) — it does not reproduce the bug (a bugfix's reproduction must fail before the fix and pass after)`,
      });
    }
  }
  return { name: 'reproduction', status: findings.length === 0 ? 'pass' : 'fail', findings };
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
 * Routing when an override is present (design §3): FORCED to `human` regardless of
 * the computed tier — the override buys a gate bypass, and the compensating
 * control is a mandatory human review. The tier's own routing reasons are folded
 * in beneath so the report still explains what the tier would have decided. Pure.
 */
export function routingWithOverride(decision: TierDecision): RoutingDecision {
  const base = routingFor(decision);
  return {
    decision: 'human',
    reasons: ['override present → human review required regardless of tier', ...base.reasons],
  };
}

/**
 * Review check (P2-10; charter §Verdict Schema & the Enumerated-Blocking Rule;
 * design phase-2.md §5): green iff the fail-closed evaluator (review/verdict.ts)
 * decided `pass`. Every failure shape is a red CHECK, never a throw — a
 * malformed verdict is a reviewer block (charter §528), and enforcement lives in
 * this deterministic code, never in the reviewer's prompt.
 *
 * Finding format is the `why` trail (design §8: "rubric line + evidence +
 * remediation"): id = the rubric line, message = explanation — file:line; fix.
 * P2-16's `crucible why <R-id>` walks exactly these fields back to the source. A
 * fail-closed outcome (NO_VERDICT / MALFORMED_VERDICT / UNKNOWN_RUBRIC_ID /
 * INCONSISTENT_VERDICT / RUBRIC_HASH_MISMATCH) has no rubric line to cite; its
 * finding id is the machine code so the failure class is still addressable.
 */
export function reviewCheck(outcome: VerdictOutcome): CheckResult {
  if (outcome.status === 'pass') {
    return { name: 'review', status: 'pass', findings: [] };
  }
  const findings: VerifyFinding[] =
    outcome.blockingFindings.length > 0
      ? outcome.blockingFindings.map((f): VerifyFinding => ({
          check: 'review',
          id: f.rubric,
          message: `${f.explanation} — ${f.evidence.file}:${f.evidence.line}; fix: ${f.remediation}`,
        }))
      : [{ check: 'review', id: outcome.code, message: outcome.reason }];
  return { name: 'review', status: 'fail', findings };
}

/**
 * Trajectory stamp builder (P2-11; design phase-2.md §6). Turns the
 * `local_verify_ran` fact into the report section: clean when a local verify was
 * recorded, else a single ADVISE-LEVEL advisory nudging the operator to run
 * verify locally before pushing. This is a parked check (capture now, judge
 * later) — the advisory is surfaced but NEVER blocks (invariant 11), so it lives
 * in `extras`, not in `checks` (which drive the verdict). Pure — a function of
 * the one boolean fact the caller read from state.
 */
export function trajectoryStamp(localVerifyRan: boolean): TrajectoryReport {
  return {
    local_verify_ran: localVerifyRan,
    advisories: localVerifyRan
      ? []
      : [
          {
            code: 'LOCAL_VERIFY_NOT_RUN',
            message:
              'no local `crucible verify` was recorded in state before push, but crucible.yaml ' +
              'sets trajectory.require_local_verify — run verify locally before pushing ' +
              '(advisory only: trajectory checks are parked, this never blocks the merge)',
          },
        ],
  };
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
 * disprove) — UNLESS an override is present, which forces the verdict to `pass`
 * (the gate bypass is permitted; design §3). The per-check statuses are preserved
 * verbatim either way, so an override report still shows exactly which checks it
 * bypassed. Validated against the schema so a malformed report fails closed.
 */
export function aggregate(
  change: string,
  checks: CheckResult[],
  extras: ReportExtras = {},
): VerifyReport {
  const checksVerdict: CheckStatus = checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
  // An override permits the bypass: the verdict is green-with-override, but the red
  // checks remain visible in the report and routing is forced human (CI still gates).
  const verdict: CheckStatus = extras.override ? 'pass' : checksVerdict;
  return verifyReportSchema.parse({
    change,
    checks,
    verdict,
    ...(extras.tier ? { tier: extras.tier } : {}),
    ...(extras.routing ? { routing: extras.routing } : {}),
    ...(extras.override ? { override: extras.override } : {}),
    ...(extras.review ? { review: extras.review } : {}),
    ...(extras.trajectory ? { trajectory: extras.trajectory } : {}),
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
  const overrideNote = report.override ? ' (OVERRIDE)' : '';
  lines.push(`${label} ${report.change}: ${report.verdict.toUpperCase()}${overrideNote}`);
  if (report.tier) {
    lines.push(`  tier: ${report.tier.tier}`);
  }
  if (report.routing) {
    lines.push(`  routing: ${report.routing.decision}`);
  }
  if (report.override) {
    lines.push(`  override: ${report.override.reason}`);
    lines.push('    ↳ gate bypassed — human review forced; a ratchet issue will be filed');
  }
  for (const check of report.checks) {
    lines.push(`  [${check.status === 'pass' ? 'PASS' : 'FAIL'}] ${check.name}`);
    for (const finding of check.findings) {
      lines.push(`      ✗ ${finding.id}: ${finding.message}`);
    }
  }
  // Trajectory stamp (P2-11) — advise-level, never a block. Rendered so a green
  // report still surfaces "was local verify run before push?" and any advisory.
  if (report.trajectory) {
    lines.push(`  local verify ran: ${report.trajectory.local_verify_ran ? 'yes' : 'no'}`);
    for (const advisory of report.trajectory.advisories) {
      lines.push(`      ⚠ ${advisory.code}: ${advisory.message}`);
    }
  }
  // Reviewer observations — the harvest channel (charter §530). Non-blocking by
  // construction; rendered so a green report still surfaces what was noticed.
  if (report.review && report.review.observations.length > 0) {
    lines.push('  observations (reviewer, non-blocking):');
    for (const obs of report.review.observations) {
      lines.push(`      · ${obs.note}`);
    }
  }
  return lines.join('\n');
}
