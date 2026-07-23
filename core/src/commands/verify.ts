// `crucible verify` — the machine that decides green/red (charter §How Verify
// Executes; design phase-0-1.md §8). verify is the read-only check the implement
// inner loop runs on every iteration and the authority CI runs on merge. It
// orchestrates three checks and aggregates them into a VerifyReport:
//
//   1. traceability lint — every REQ has an oracle, every oracle a real REQ,
//      every binding resolves (the cheap millisecond gate; charter: run this
//      before you run anything).
//   2. oracle run — execute the current-change oracles via the adapter and join
//      results back to oracle ids (skip→fail is already coerced in the client).
//      The regression suite (all archived bindings) is empty in P1 (no archive).
//   3. approval-hash — recompute every sealed file's hash; any mismatch or
//      missing file voids the approval (invariant 6). Run ONLY when an
//      approval.yaml exists, so a pre-approve verify (during propose) skips it
//      cleanly rather than failing.
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
  oraclesCheck,
  traceabilityCheck,
  type CheckResult,
  type VerifyReport,
} from '../verifyx/report.js';
import { preconditionError } from '../util/errors.js';
import { readdirSync, statSync } from 'node:fs';

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
}

/** verify invocation options. `root` is the repo root the seal is relative to. */
export interface VerifyOptions {
  /** Repo root: approval hashes are recomputed relative to this (design §4). */
  root: string;
  /** The change to verify (its bundle lives at openspec/changes/<change>/). */
  change: string;
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

  const checks: CheckResult[] = [];

  // Check 1 — traceability lint (the cheap gate; no tests run).
  const lint = await lintTraceability(requirements, oracles, deps.resolve);
  const trace = traceabilityCheck(lint);
  checks.push(trace);

  // Check 2 — oracle run, ONLY when the lint gate is green. Running tests against
  // unresolved or uncovered bindings is meaningless; a red lint already fails the
  // verdict, so short-circuit rather than ask the adapter for phantom targets.
  if (trace.status === 'pass') {
    const results = await deps.run(oracles);
    checks.push(oraclesCheck(results));
  }

  // Check 3 — approval-hash, ONLY when a seal exists. A pre-approve verify (during
  // propose) has no approval.yaml and skips this cleanly (not a failure). A void
  // seal is a red check here (exit 1), never a silent pass (invariant 6).
  const approvalPath = join(changeDir, 'approval.yaml');
  if (existsSync(approvalPath)) {
    const approval = loadApproval(approvalPath);
    checks.push(approvalCheck(verifyApproval(root, approval)));
  }

  return aggregate(change, checks);
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
