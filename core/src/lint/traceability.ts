// Traceability linter v0 — three-way integrity (charter §Traceability Lint —
// Mechanics; design phase-0-1.md §8).
//
// The linter is the gate that turns "we wrote some oracles" into "every promise
// in the spec is pinned by an executable check that actually collects." It does
// three extractions + set arithmetic over already-parsed, typed inputs:
//   (a) the REQ ids in the spec delta        (from artifacts/spec-delta)
//   (b) each oracle's REQ-link + its binding  (from artifacts/oracles)
//   (c) the collectible target universe       (via an injected adapter `resolve`)
// and runs three checks:
//   1. coverage   — every REQ has ≥1 oracle (else "a wish, not a spec")
//   2. orphan     — every oracle points at a REQ in the delta or the archived spec
//   3. binding    — every target resolves (the adapter can collect it)
// Every miss becomes a machine-readable Finding naming the EXACT id so verify /
// approve can render + block on it. No tests are executed here — `resolve` is a
// dry-run (charter: "Milliseconds; no tests run").
//
// This module is deterministic (invariant 12): same inputs → same findings in
// the same order. It imports NO adapter (invariant: the linter takes `resolve`
// injected; the command layer wires the real adapter client in), and it never
// spawns a process. Malformed *artifacts* fail closed at exit 3 in the parsers
// upstream; a lint miss here is a *check failure* (exit 1 at the command layer),
// not malformed input — so this returns a report rather than throwing. The one
// fail-closed rule it owns: a target the resolver drops or reports as anything
// other than `found` counts as unresolved (invariant 3 — never silently pass).

import type { Oracle } from '../artifacts/oracles.js';
import type { SpecRequirement } from '../artifacts/spec-delta.js';

/**
 * One resolved target, the shape the injected `resolve` returns. Structurally
 * identical to the adapter client's resolve result, redeclared here so the
 * linter carries no adapter import (charter §Bindings & the Adapter Protocol:
 * `resolve` is a batch dry-run — does this target exist/collect?).
 */
export interface TargetResolution {
  target: string;
  status: 'found' | 'missing';
  /** Present only when `found`: the file the target lives in (unused by lint).
   * `| undefined` so the adapter client's zod-inferred resolve result (its
   * optionals admit explicit `undefined`) is assignable under
   * `exactOptionalPropertyTypes` — the tracer wires the real client here. */
  targetFile?: string | undefined;
}

/**
 * The injected dry-run resolver: a batch of opaque targets → one resolution
 * each. Async because the real implementation spawns the adapter process; the
 * linter treats it as an opaque oracle of collectibility.
 */
export type ResolveFn = (targets: readonly string[]) => Promise<readonly TargetResolution[]>;

/** Which of the three integrity checks a finding reports. */
export type FindingKind = 'requirement-without-oracle' | 'orphan-oracle' | 'unresolved-binding';

/** One machine-readable traceability miss. `id` is always the exact id at fault. */
export interface Finding {
  kind: FindingKind;
  /** The REQ id (coverage) or ORC id (orphan, binding) the miss is about. */
  id: string;
  /** One-line human rendering; the structured fields are the source of truth. */
  message: string;
  /** orphan-oracle: the requirement the oracle pointed at but that doesn't exist. */
  requirement?: string;
  /** unresolved-binding: the target the adapter could not collect. */
  target?: string;
  /** 1-based source line of the offending REQ/oracle heading, for display. */
  line?: number;
}

/** The linter's verdict: green iff `findings` is empty. */
export interface LintReport {
  ok: boolean;
  findings: Finding[];
}

/**
 * Run the three traceability checks. Deterministic; findings are grouped by
 * check (coverage, then orphan, then binding) and within each group follow
 * source order (spec-delta order for REQs, oracle order for oracles, binding
 * order for targets) so the output is stable and reviewable.
 */
export async function lintTraceability(
  requirements: readonly SpecRequirement[],
  oracles: readonly Oracle[],
  resolve: ResolveFn,
  archivedRequirementIds: ReadonlySet<string> = new Set(),
): Promise<LintReport> {
  const findings: Finding[] = [];

  // Extraction (b): which REQ ids are covered by ≥1 oracle, and the REQ-id set.
  const requirementIds = new Set(requirements.map((r) => r.id));
  const coveredRequirementIds = new Set(oracles.map((o) => o.binding.requirement));

  // Check 1 — coverage: every REQ has ≥1 oracle, else it is a wish.
  for (const requirement of requirements) {
    if (!coveredRequirementIds.has(requirement.id)) {
      findings.push({
        kind: 'requirement-without-oracle',
        id: requirement.id,
        line: requirement.line,
        message: `requirement ${requirement.id} has no oracle — a requirement without an oracle is a wish, not a spec`,
      });
    }
  }

  // Check 2 — orphan: every oracle points at a REQ that exists in the delta OR in
  // the archived spec (charter §ID grammar; design phase-2.md §1). The archived
  // index is how a bugfix/ratchet oracle (e.g. ORC-refund-013) legally binds an
  // OLD requirement id that carries no delta of its own this change — while an id
  // in NEITHER set is still a real orphan (a typo or a promise that never existed).
  for (const oracle of oracles) {
    const requirement = oracle.binding.requirement;
    if (!requirementIds.has(requirement) && !archivedRequirementIds.has(requirement)) {
      findings.push({
        kind: 'orphan-oracle',
        id: oracle.id,
        requirement,
        line: oracle.line,
        message: `oracle ${oracle.id} points at ${requirement}, which is not a requirement in the spec delta or the archived spec`,
      });
    }
  }

  // Extraction (c): the deduped target universe (first-appearance order), dry-run
  // resolved in a single batch. Skip the call entirely when nothing binds.
  const universe = dedupeTargets(oracles);
  const resolutions =
    universe.length === 0
      ? new Map<string, TargetResolution>()
      : indexResolutions(await resolve(universe));

  // Check 3 — binding: every target of every oracle resolves as `found`. A target
  // the resolver dropped or reported as non-`found` is unresolved (fail-closed).
  for (const oracle of oracles) {
    for (const target of oracle.binding.targets) {
      const resolution = resolutions.get(target);
      if (resolution === undefined || resolution.status !== 'found') {
        findings.push({
          kind: 'unresolved-binding',
          id: oracle.id,
          target,
          line: oracle.line,
          message: `oracle ${oracle.id} binds target ${target}, which the adapter could not resolve — the check does not exist or is not collected`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

/** The distinct targets across all oracle bindings, in first-appearance order. */
function dedupeTargets(oracles: readonly Oracle[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const oracle of oracles) {
    for (const target of oracle.binding.targets) {
      if (!seen.has(target)) {
        seen.add(target);
        ordered.push(target);
      }
    }
  }
  return ordered;
}

/** Index resolutions by target; first result for a target wins (deterministic). */
function indexResolutions(resolutions: readonly TargetResolution[]): Map<string, TargetResolution> {
  const byTarget = new Map<string, TargetResolution>();
  for (const resolution of resolutions) {
    if (!byTarget.has(resolution.target)) byTarget.set(resolution.target, resolution);
  }
  return byTarget;
}
