// `crucible verify` — the machine that decides green/red (charter §How Verify
// Executes; design phase-0-1.md §8). verify is the read-only check the implement
// inner loop runs on every iteration and the authority CI runs on merge. It
// orchestrates three checks and aggregates them into a VerifyReport:
//
//   1. traceability lint — every REQ has an oracle, every oracle a real REQ,
//      every binding resolves (the cheap millisecond gate; charter: run this
//      before you run anything).
//   2. oracle run — execute the current-change oracles via the adapter and join
//      results back to oracle ids (skip→fail is already coerced in the client) —
//      PLUS the regression suite: every archived binding, collected from the
//      archive on disk and re-run so a broken past promise is a red verdict
//      (charter §The Regression Suite; design phase-2.md §1). Reported as a
//      distinct `regression` check when the suite is non-empty.
//   3. approval-hash — recompute every sealed file's hash; any mismatch or
//      missing file voids the approval (invariant 6). Run ONLY when an
//      approval.yaml exists, so a pre-approve verify (during propose) skips it
//      cleanly rather than failing.
//
// On the authoritative path (the real CLI / CI, where enforcement config + the
// diff-facts edge are supplied) it ALSO recomputes the tier (invariant 8) from
// the diff, enforces the per-tier diff cap as a fourth check (a breach is a red
// verdict naming the tier + cap), and attaches the tier + the merge-path routing
// (auto | human) to the report (design phase-2.md §2). Given neither input it
// runs the three P1 checks only — the inner-loop / pre-approve verify path.
//
// An override.yaml in the bundle is the 2am escape hatch (charter §Override;
// design phase-2.md §3): it forces the verdict green-with-`override`, forces
// routing → human regardless of tier, and emits the ratchet-issue payload CI
// files — a loud, self-repairing bypass, never a quiet one.
//
// Verdict is `fail` if any check is red; the CLI layer maps that to exit 1 via
// `CheckFailure` (a verdict, not an error). Fail-closed (invariant 3): a
// malformed artifact throws exit 3 from the parsers; adapter transport failure
// throws exit 3 from the client — neither is downgraded to a red finding.
//
// Determinism (invariant 12): the dry-run resolver and the oracle runner are
// injected (`VerifyDeps`); the core spawns no process and writes NO state — verify
// is a pure check that also runs in CI's ephemeral checkout (charter §State &
// Audit: CI can't commit state back). The lint gate short-circuits the oracle
// run: running tests against unresolved bindings is meaningless.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadSpecDelta, type SpecRequirement } from '../artifacts/spec-delta.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import type { OracleResult } from '../adapters/types.js';
import {
  aggregate,
  approvalCheck,
  diffCapCheck,
  oraclesCheck,
  regressionCheck,
  routingFor,
  routingWithOverride,
  traceabilityCheck,
  type CheckResult,
  type OverrideReport,
  type ReportExtras,
  type VerifyReport,
} from '../verifyx/report.js';
import { collectArchivedRequirementIds, collectRegressionSuite } from '../regression/regression.js';
import { computeTier } from '../tier/tier.js';
import { buildRatchetIssue, loadOverride } from '../artifacts/override.js';
import type { EnforcementConfig } from '../config/enforcement.js';
import { preconditionError } from '../util/errors.js';
import { readdirSync, statSync } from 'node:fs';

/** The diff facts the tier computation rests on (design phase-2.md §2). */
export interface DiffFacts {
  /** Repo-relative paths changed vs the diff base (for risk-glob matching). */
  touchedPaths: readonly string[];
  /** Total changed lines (added + deleted) vs the diff base (for the cap). */
  diffLines: number;
}

/** Injected non-deterministic edges — so verify's core stays reproducible. */
export interface VerifyDeps {
  /**
   * Batch dry-run resolver (charter §Bindings & the Adapter Protocol) — powers
   * the traceability lint. Injected because the real one spawns the adapter (P1-11
   * client); tests pass a pure function.
   */
  resolve: ResolveFn;
  /**
   * Execute every oracle's bound targets and join results back to oracle ids
   * (the adapter client's `run`). skip→fail is coerced in the client, not here.
   */
  run: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
  /**
   * Assemble the diff facts (touched paths + changed lines) vs the diff base —
   * the git edge, injected so the core stays deterministic (design §2, following
   * the P1-14 `StatusDeps` precedent). In an enforcement context an uncomputable
   * diff is exit 3 (the live edge throws; never "assume trivial"). Supplied only
   * on the authoritative CLI/CI path; omitted → verify skips tier computation and
   * behaves as in P1 (the inner-loop / pre-approve verify).
   */
  diffFacts?: () => DiffFacts;
}

/** verify invocation options. `root` is the repo root the seal is relative to. */
export interface VerifyOptions {
  /** Repo root: approval hashes are recomputed relative to this (design §4). */
  root: string;
  /** The change to verify (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /**
   * Enforcement config the tier is computed against (risk globs + diff caps). In
   * CI this is the *target-branch* config (invariant 7), resolved by the CLI via
   * `--config-from`. Supplied together with `deps.diffFacts` to enable the tier /
   * routing / diff-cap checks; omitted → verify runs the P1 checks only.
   */
  config?: EnforcementConfig;
}

/**
 * Run verify's three checks and aggregate them into a report. Throws
 * `CrucibleError` (exit 2) if the change bundle is absent, or exit 3 (bubbling
 * from the parsers / adapter client) on a malformed artifact or a broken judge.
 * A red *verdict* is returned in the report (verdict `fail`), never thrown — the
 * CLI maps it to exit 1.
 */
export async function verify(options: VerifyOptions, deps: VerifyDeps): Promise<VerifyReport> {
  const { root, change } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // Parse the bundle. Missing spec delta → exit 2; malformed artifact → exit 3.
  const requirements = loadAllRequirements(changeDir, changeRel);
  const oracles = loadOracles(join(changeDir, 'oracles.md'));

  // Override — the 2am escape hatch (charter §Override; design §3). An
  // override.yaml in the bundle PERMITS a gate bypass: it forces the verdict green
  // (in `aggregate`) and routing → human regardless of tier (below), and emits the
  // ratchet-issue payload CI files. A malformed override.yaml is exit 3 from the
  // loader (fail-closed) — a bypass we cannot read is not a bypass we honor.
  const overridePath = join(changeDir, 'override.yaml');
  let override: OverrideReport | undefined;
  if (existsSync(overridePath)) {
    const loaded = loadOverride(overridePath);
    override = { reason: loaded.reason, issue: buildRatchetIssue(loaded) };
  }

  // Tier / routing / diff-cap — computed ONLY when the caller supplied enforcement
  // config AND the diff-facts edge (the authoritative CLI/CI path). The `tier/`
  // module is pure (invariant 12): the git edge already ran in `deps.diffFacts`,
  // and an uncomputable diff has already thrown exit 3 there (design §2). Without
  // both inputs verify runs the P1 checks only (inner-loop / pre-approve verify).
  let extras: ReportExtras = {};
  let capCheck: CheckResult | undefined;
  if (options.config && deps.diffFacts) {
    const facts = deps.diffFacts();
    const decision = computeTier(
      {
        // A spec delta guarantees ≥ standard (invariant 8, rule 2). verify already
        // required a spec delta above, so this is true on every reachable path
        // today; kept explicit for when refactor bundles (no delta) arrive (P2-07).
        specDelta: requirements.length > 0,
        touchedPaths: facts.touchedPaths,
        diffLines: facts.diffLines,
      },
      options.config,
    );
    // An override forces routing → human regardless of the computed tier (design §3).
    const routing = override ? routingWithOverride(decision) : routingFor(decision);
    extras = { tier: decision, routing };
    capCheck = diffCapCheck(decision);
  }
  // Carried on every path (inner-loop verify included) so a bypass is always flagged.
  if (override) extras.override = override;

  const checks: CheckResult[] = [];

  // Check 1 — traceability lint (the cheap gate; no tests run). The archived-REQ
  // index lets a bugfix/ratchet oracle legally bind an OLD requirement id that
  // lives only in the archived spec (charter §ID grammar; design §1). It is a
  // deterministic filesystem read (like loading the bundle), not an injected edge.
  const archivedReqIds = collectArchivedRequirementIds(root);
  const lint = await lintTraceability(requirements, oracles, deps.resolve, archivedReqIds);
  const trace = traceabilityCheck(lint);
  checks.push(trace);

  // Check 2 — diff cap (config-only; independent of the lint gate). A breach is a
  // red verdict naming the tier + cap (design §2). Present only on the config path.
  if (capCheck) checks.push(capCheck);

  // Checks 3 & 4 — oracle run + regression run, ONLY when the lint gate is green.
  // Running tests against unresolved or uncovered bindings is meaningless; a red
  // lint already fails the verdict, so short-circuit. verify judges the current
  // change's oracles AND re-runs the whole regression suite — every archived
  // binding, collected from the archive on disk (charter §The Regression Suite;
  // design §1). A broken PAST promise (a refactor that changed pinned behavior) is
  // a red verdict just like a failing current oracle. Both run through the one
  // injected `run` edge in a single batch; results are partitioned back by id so
  // each is attributed to its own check (`oracles` vs `regression`).
  if (trace.status === 'pass') {
    const regression = collectRegressionSuite(root).oracles;
    const currentIds = new Set(oracles.map((o) => o.id));
    const results = await deps.run([...oracles, ...regression]);
    checks.push(oraclesCheck(results.filter((r) => currentIds.has(r.oracleId))));
    if (regression.length > 0) {
      checks.push(regressionCheck(results.filter((r) => !currentIds.has(r.oracleId))));
    }
  }

  // Check 4 — approval-hash, ONLY when a seal exists. A pre-approve verify (during
  // propose) has no approval.yaml and skips this cleanly (not a failure). A void
  // seal is a red check here (exit 1), never a silent pass (invariant 6).
  const approvalPath = join(changeDir, 'approval.yaml');
  if (existsSync(approvalPath)) {
    const approval = loadApproval(approvalPath);
    checks.push(approvalCheck(verifyApproval(root, approval)));
  }

  return aggregate(change, checks, extras);
}

/**
 * Parse every spec-delta markdown under the change's `specs/**` into one ordered
 * requirement list (files sorted by path, requirements in source order). A bundle
 * with no spec delta at all is a precondition failure (exit 2) — verify has
 * nothing to trace. (Trivial-tier changes carry no spec delta and no oracles;
 * tier-aware verify is P2. This mirrors approve's loader; a shared
 * `artifacts/bundle` extraction is flagged as follow-up.)
 */
function loadAllRequirements(changeDir: string, changeRel: string): SpecRequirement[] {
  const specsDir = join(changeDir, 'specs');
  const specFiles = existsSync(specsDir) ? markdownFilesUnder(specsDir).sort() : [];
  if (specFiles.length === 0) {
    throw preconditionError(
      'NO_SPEC_DELTA',
      `No spec delta found under ${join(changeRel, 'specs')}.`,
      'Run `crucible propose` to scaffold the change bundle with a spec delta.',
    );
  }
  return specFiles.flatMap((file) => loadSpecDelta(file));
}

/** All `.md` files under `dir` (recursive), absolute paths. Empty if absent. */
function markdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...markdownFilesUnder(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}
