import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('verify — override (the 2am hatch: design §3, P2-06)', () => {
  function toyConfig(): EnforcementConfig {
    return loadEnforcementConfig(scratch);
  }
  function facts(touchedPaths: string[], diffLines: number): () => DiffFacts {
    return () => ({ touchedPaths, diffLines });
  }
  /** Write a valid override.yaml into the change bundle. */
  function writeOverride(reason: string): void {
    writeFileSync(
      join(scratch, CHANGE_REL, 'override.yaml'),
      [
        'version: 1',
        `change: ${CHANGE}`,
        `reason: ${JSON.stringify(reason)}`,
        'created_by: ada@example.com',
        'created_at: 2026-07-25T02:00:00Z',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  it('override present + a RED oracle check → verdict pass with the override flag', async () => {
    // Without the override this fixture would be red (the first oracle fails).
    writeOverride('2am prod incident');
    const report = await verify({ root: scratch, change: CHANGE }, deps({ run: runFirstFails }));
    // Green-with-override: the bypass is permitted (acceptance).
    expect(report.verdict).toBe('pass');
    expect(report.override).toBeDefined();
    expect(report.override?.reason).toBe('2am prod incident');
    // The red check is still visible — the override does not hide what it bypassed.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('fail');
  });

  it('override forces routing → human even for a normally-auto (standard) tier', async () => {
    // Baseline: this same change/diff routes AUTO without an override.
    const auto = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(auto.routing?.decision).toBe('auto');

    // With an override it is forced to human regardless of the computed tier.
    writeOverride('shipping ahead of review');
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(report.tier?.tier).toBe('standard');
    expect(report.routing?.decision).toBe('human');
    expect(report.routing?.reasons.some((r) => r.toLowerCase().includes('override'))).toBe(true);
  });

  it('emits a ratchet-issue payload naming the change, labeled crucible-override', async () => {
    writeOverride('needs a retroactive proposal');
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    const issue = report.override?.issue;
    expect(issue).toBeDefined();
    expect(issue?.title).toContain(CHANGE);
    expect(issue?.labels).toContain('crucible-override');
    expect(issue?.body).toContain('needs a retroactive proposal');
    // The whole report still validates as a trust-boundary verdict.
    expect(() => verifyReportSchema.parse(report)).not.toThrow();
  });

  it('override even flips a diff-cap breach green (the gate is bypassed)', async () => {
    writeOverride('oversized emergency change');
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 500) }),
    );
    // The cap check is red, but the override forces the verdict green.
    expect(report.checks.find((c) => c.name === 'diff-cap')?.status).toBe('fail');
    expect(report.verdict).toBe('pass');
    expect(report.routing?.decision).toBe('human');
  });

  it('a malformed override.yaml fails closed at exit 3, not a silent bypass', async () => {
    writeFileSync(join(scratch, CHANGE_REL, 'override.yaml'), 'reason: 42\nrogue: [\n', 'utf8');
    const err = await catchCrucible(() => verify({ root: scratch, change: CHANGE }, deps()));
    expect(err.exit).toBe(3);
  });
});

describe('verify — regression suite (design phase-2.md §1)', () => {
  // A prior change, archived: its oracles are the regression suite that every
  // later change's verify must re-run (charter §The Regression Suite).
  const ARCHIVED_ORACLES = `# Oracles — add-farewell

## ORC-farewell-001: Farewell names the person
**Then** the result is \`Bye, <name>!\`

\`\`\`yaml crucible-binding
requirement: REQ-farewell-basic-1
kind: unit
runner: stub
target: farewell::bye_for_a_name
\`\`\`
`;

  function archivePriorChange(root: string): void {
    const dir = join(root, 'openspec', 'changes', 'archive', '2026-07-24-add-farewell');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'oracles.md'), ARCHIVED_ORACLES, 'utf8');
  }

  it('verify on a later change RE-RUNS every archived binding (acceptance)', async () => {
    archivePriorChange(scratch);
    const ranIds: string[] = [];
    const run = (oracles: readonly Oracle[]): Promise<OracleResult[]> => {
      for (const o of oracles) ranIds.push(o.id);
      return runAllPass(oracles);
    };

    const report = await verify({ root: scratch, change: CHANGE }, deps({ run }));

    // The archived oracle was executed alongside the current change's oracles.
    expect(ranIds).toContain('ORC-farewell-001');
    expect(ranIds).toContain('ORC-greeting-001');
    // A distinct `regression` check is emitted and green.
    const regression = report.checks.find((c) => c.name === 'regression');
    expect(regression?.status).toBe('pass');
    expect(report.verdict).toBe('pass');
  });

  it('a broken PAST promise fails the verdict, attributed to `regression`', async () => {
    archivePriorChange(scratch);
    // The archived (regression) oracle now fails; current-change oracles pass.
    const run = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
      Promise.resolve(
        oracles.map((o): OracleResult => {
          const failing = o.id === 'ORC-farewell-001';
          return {
            oracleId: o.id,
            requirement: o.binding.requirement,
            status: failing ? 'fail' : 'pass',
            targets: o.binding.targets.map((t) => ({
              target: t,
              status: failing ? ('fail' as const) : ('pass' as const),
            })),
          };
        }),
      );

    const report = await verify({ root: scratch, change: CHANGE }, deps({ run }));

    expect(report.verdict).toBe('fail');
    const regression = report.checks.find((c) => c.name === 'regression');
    expect(regression?.status).toBe('fail');
    expect(regression?.findings[0]?.id).toBe('ORC-farewell-001');
    // The current change's own oracles check stays green — the red is the past promise.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('pass');
  });

  it('no archive → no `regression` check emitted (nothing to re-run)', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.checks.some((c) => c.name === 'regression')).toBe(false);
  });

  it('a red current lint short-circuits the regression run too (cheap gate first)', async () => {
    archivePriorChange(scratch);
    const report = await verify(
      { root: scratch, change: CHANGE },
      deps({ resolve: resolveAllMissing, run: runNeverCalled }),
    );
    expect(report.verdict).toBe('fail');
    expect(report.checks.some((c) => c.name === 'regression')).toBe(false);
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
