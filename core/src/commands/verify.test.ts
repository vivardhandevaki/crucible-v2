import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { verifyReportSchema } from '../verifyx/report.js';
import { loadEnforcementConfig, type EnforcementConfig } from '../config/enforcement.js';
import { verify, type DiffFacts, type VerifyDeps } from './verify.js';

// TCB: verify is the machine that decides green/red. It parses the bundle, runs
// the three checks (traceability lint → oracle run → approval-hash), and
// aggregates them into a report whose verdict is fail iff any check failed
// (design phase-0-1.md §8; charter §How Verify Executes). It must attribute each
// red to its check and stay deterministic (invariant 12): the dry-run resolver
// and the oracle runner are injected, so the core never spawns a real adapter.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

// The toy repo's two oracle targets → the files they live in (tests.json).
const TARGET_FILES: Record<string, string> = {
  'greeting::returns_hello_for_a_name': 'tests/greeting.test.ts',
  'greeting::defaults_to_world_when_empty': 'tests/greeting.test.ts',
};

/** Resolver: every requested target `found` with its file (green lint). */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => {
      const targetFile = TARGET_FILES[target];
      return targetFile !== undefined
        ? { target, status: 'found', targetFile }
        : { target, status: 'missing' };
    }),
  );

/** Resolver: every target missing (drives the red-lint / unresolved-binding path). */
const resolveAllMissing: ResolveFn = (targets) =>
  Promise.resolve(targets.map((target): TargetResolution => ({ target, status: 'missing' })));

/** Runner: every oracle passes (green oracle check). */
const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: 'pass',
      targets: o.binding.targets.map((t) => ({ target: t, status: 'pass' as const })),
    })),
  );

/** Runner: the FIRST oracle fails (a bound target reports skip → fail). */
const runFirstFails = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o, i): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: i === 0 ? 'fail' : 'pass',
      targets: o.binding.targets.map((t) => ({
        target: t,
        status: i === 0 ? ('skip' as const) : ('pass' as const),
      })),
    })),
  );

/** A runner that must never be called (asserts the lint gate short-circuits). */
const runNeverCalled = (): Promise<OracleResult[]> => {
  throw new Error('deps.run must not be called when the traceability gate is red');
};

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-verify-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return { resolve: resolveAllFound, run: runAllPass, ...overrides };
}

/** Seal an approval.yaml over the given relpaths so the hash check has something to verify. */
function writeApproval(root: string, relpaths: string[]): void {
  const approval = sealBundle(root, relpaths, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: '2026-07-23T00:00:00Z',
  });
  writeFileSync(join(root, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}

/** Capture the CrucibleError a call throws, or fail the test loudly. */
async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('verify — green path', () => {
  it('valid fixture, no approval yet → verdict pass, exit-worthy 0', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.verdict).toBe('pass');
    expect(report.checks.map((c) => c.name)).toEqual(['traceability', 'oracles']);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    // The approval-hash check is skipped cleanly when no seal exists (pre-approve
    // verify during propose) — no 'approval' entry, and NOT a failure.
    expect(report.checks.some((c) => c.name === 'approval')).toBe(false);
  });

  it('the report validates against verifyReportSchema (verdict JSON is a trust boundary)', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(() => verifyReportSchema.parse(report)).not.toThrow();
  });
});

describe('verify — red source: traceability lint', () => {
  it('unresolved bindings → verdict fail, finding attributed to traceability, oracles NOT run', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE },
      deps({ resolve: resolveAllMissing, run: runNeverCalled }),
    );
    expect(report.verdict).toBe('fail');
    const trace = report.checks.find((c) => c.name === 'traceability');
    expect(trace?.status).toBe('fail');
    expect(trace?.findings.every((f) => f.check === 'traceability')).toBe(true);
    // The lint gate short-circuits the oracle run.
    expect(report.checks.some((c) => c.name === 'oracles')).toBe(false);
    // The exact offending oracle id is named.
    expect(trace?.findings.map((f) => f.id)).toContain('ORC-greeting-001');
  });
});

describe('verify — red source: oracle failure', () => {
  it('a bound target fails → verdict fail, finding attributed to oracles, naming the ORC id', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps({ run: runFirstFails }));
    expect(report.verdict).toBe('fail');
    const trace = report.checks.find((c) => c.name === 'traceability');
    expect(trace?.status).toBe('pass');
    const oracles = report.checks.find((c) => c.name === 'oracles');
    expect(oracles?.status).toBe('fail');
    expect(oracles?.findings).toHaveLength(1);
    expect(oracles?.findings[0]?.check).toBe('oracles');
    expect(oracles?.findings[0]?.id).toBe('ORC-greeting-001');
  });
});

describe('verify — red source: hash void', () => {
  it('a sealed file edited after approval → verdict fail, finding attributed to approval', async () => {
    // Seal + tamper proposal.md (a sealed artifact the lint does NOT re-parse) so
    // the ONLY red source is the hash void — editing oracles.md would also break
    // the traceability lint and muddy the attribution.
    const sealed = join(CHANGE_REL, 'proposal.md');
    writeApproval(scratch, [sealed]);
    // Tamper with a sealed file after the seal — the classic post-approval edit.
    writeFileSync(join(scratch, sealed), '# tampered\n', 'utf8');

    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.verdict).toBe('fail');
    const approval = report.checks.find((c) => c.name === 'approval');
    expect(approval?.status).toBe('fail');
    expect(approval?.findings.map((f) => f.id)).toContain(sealed);
    expect(approval?.findings.every((f) => f.check === 'approval')).toBe(true);
    // Lint + oracles are still green — only the hash void is red.
    expect(report.checks.find((c) => c.name === 'traceability')?.status).toBe('pass');
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('pass');
  });

  it('a valid, untampered seal → the approval check passes', async () => {
    writeApproval(scratch, [join(CHANGE_REL, 'oracles.md'), join(CHANGE_REL, 'proposal.md')]);
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.verdict).toBe('pass');
    expect(report.checks.find((c) => c.name === 'approval')?.status).toBe('pass');
  });
});

describe('verify — tier, routing & diff caps (config + diff-facts path)', () => {
  // The toy repo's crucible.yaml: risk.critical includes `src/**/auth/**`,
  // `.crucible/**`, `crucible.yaml`; tiers trivial 150 / standard 400 / critical
  // 400. Loaded from the scratch copy so the test rides the real config shape.
  function toyConfig(): EnforcementConfig {
    return loadEnforcementConfig(scratch);
  }

  /** A diff-facts edge returning fixed touched paths + line count (no git). */
  function facts(touchedPaths: string[], diffLines: number): () => DiffFacts {
    return () => ({ touchedPaths, diffLines });
  }

  it('a risk-glob match dominates → critical → routing human', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/app/auth/login.ts'], 20) }),
    );
    expect(report.tier?.tier).toBe('critical');
    expect(report.routing?.decision).toBe('human');
    // The tier facts record the matched glob for the audit trail.
    expect(report.tier?.facts.risk_matches[0]?.glob).toBe('src/**/auth/**');
    // No cap breach (20 < 400) and oracles/lint green → verdict pass.
    expect(report.verdict).toBe('pass');
    expect(report.checks.find((c) => c.name === 'diff-cap')?.status).toBe('pass');
  });

  it('a spec delta with no risk match → standard → routing auto', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(report.tier?.tier).toBe('standard');
    expect(report.routing?.decision).toBe('auto');
    expect(report.verdict).toBe('pass');
  });

  it('a diff over the tier cap → diff-cap red → verdict fail naming tier + cap', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 500) }),
    );
    expect(report.verdict).toBe('fail');
    const cap = report.checks.find((c) => c.name === 'diff-cap');
    expect(cap?.status).toBe('fail');
    // The finding names the tier and its cap (acceptance).
    expect(cap?.findings[0]?.message).toContain('standard');
    expect(cap?.findings[0]?.message).toContain('400');
    // Lint + oracles are unaffected — the cap is the only red source.
    expect(report.checks.find((c) => c.name === 'traceability')?.status).toBe('pass');
  });

  it('without config + diff-facts, verify runs the P1 checks only (no tier/routing)', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.tier).toBeUndefined();
    expect(report.routing).toBeUndefined();
    expect(report.checks.some((c) => c.name === 'diff-cap')).toBe(false);
  });
});

describe('verify — preconditions & fail-closed', () => {
  it('missing change bundle → exit 2 naming the next command', async () => {
    const err = await catchCrucible(() =>
      verify({ root: scratch, change: 'no-such-change' }, deps()),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('malformed oracles.md → exit 3 (fail-closed on bad artifact, not a red verdict)', async () => {
    writeFileSync(
      join(scratch, CHANGE_REL, 'oracles.md'),
      readFileSync(join(scratch, CHANGE_REL, 'oracles.md'), 'utf8').replace(
        'crucible-binding',
        'not-a-binding',
      ),
      'utf8',
    );
    const err = await catchCrucible(() => verify({ root: scratch, change: CHANGE }, deps()));
    expect(err.exit).toBe(3);
  });
});
