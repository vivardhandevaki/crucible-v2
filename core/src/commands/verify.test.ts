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
import { verifyReportSchema, type CheckResult } from '../verifyx/report.js';
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
  return {
    resolve: resolveAllFound,
    run: runAllPass,
    runSuites: async (suites) =>
      Object.keys(suites)
        .sort()
        .map((name) => ({ name, status: 'pass' as const })),
    ...overrides,
  };
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

describe('P4R-05 verify — declared deterministic suites', () => {
  it('runs every declared suite and attributes a failure to its suite name', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: loadEnforcementConfig(scratch) },
      deps({
        runSuites: async (suites) => {
          expect(suites).toEqual({ unit: 'npm test' });
          return [{ name: 'unit', status: 'fail', message: 'exit 1' }];
        },
      }),
    );

    expect(report.verdict).toBe('fail');
    expect(report.checks.find((check) => check.name === 'suites')).toEqual({
      name: 'suites',
      status: 'fail',
      findings: [
        {
          check: 'suites',
          id: 'unit',
          message: 'suite unit failed: exit 1',
        },
      ],
    });
  });

  it('produces byte-stable reports for identical verification inputs', async () => {
    const first = await verify({ root: scratch, change: CHANGE }, deps());
    const second = await verify({ root: scratch, change: CHANGE }, deps());

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('fails closed when a configured suite has no result', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: loadEnforcementConfig(scratch) },
      { resolve: resolveAllFound, run: runAllPass, runSuites: async () => [] },
    );

    expect(report.verdict).toBe('fail');
    expect(report.checks.find((check) => check.name === 'suites')?.findings).toEqual([
      { check: 'suites', id: 'unit', message: 'suite unit returned no result' },
    ]);
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

describe('verify — trajectory stamp (P2-11, design phase-2.md §6)', () => {
  // The toy config sets trajectory.require_local_verify: true.
  function toyConfig(requireLocalVerify = true): EnforcementConfig {
    const config = loadEnforcementConfig(scratch);
    return {
      ...config,
      trajectory: { ...config.trajectory, require_local_verify: requireLocalVerify },
    };
  }

  function facts(touchedPaths: string[], diffLines: number): () => DiffFacts {
    return () => ({ touchedPaths, diffLines });
  }

  /** Write a state.yaml carrying the given event summaries (audit trail). */
  function writeState(summaries: string[]): void {
    const events = summaries.map((summary, i) => ({
      at: `2026-07-29T00:00:0${i}Z`,
      cmd: 'implement',
      summary,
    }));
    writeFileSync(
      join(scratch, CHANGE_REL, 'state.yaml'),
      `change: ${CHANGE}\nevents:\n${events
        .map((e) => `  - at: "${e.at}"\n    cmd: ${e.cmd}\n    summary: "${e.summary}"`)
        .join('\n')}\nsnapshot:\n  phase: implemented\n`,
      'utf8',
    );
  }

  it('require_local_verify + no local verify recorded → stamp false + advise finding, verdict still pass', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(report.trajectory?.local_verify_ran).toBe(false);
    expect(report.trajectory?.advisories.map((a) => a.code)).toContain('LOCAL_VERIFY_NOT_RUN');
    // Advise-level: a parked trajectory check NEVER blocks the merge (invariant 11).
    expect(report.verdict).toBe('pass');
    expect(report.checks.some((c) => c.name === 'traceability' && c.status === 'pass')).toBe(true);
  });

  it('require_local_verify + a recorded local verify event → stamp true, no advisories', async () => {
    writeState(['tasks.md generated', 'local verify pass']);
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig() },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(report.trajectory?.local_verify_ran).toBe(true);
    expect(report.trajectory?.advisories).toEqual([]);
    expect(report.verdict).toBe('pass');
  });

  it('require_local_verify false → no trajectory section (project opted out)', async () => {
    const report = await verify(
      { root: scratch, change: CHANGE, config: toyConfig(false) },
      deps({ diffFacts: facts(['src/greeting.ts'], 30) }),
    );
    expect(report.trajectory).toBeUndefined();
  });

  it('without enforcement config (inner-loop verify) → no trajectory section', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.trajectory).toBeUndefined();
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

describe('verify — reproduction (bugfix red-on-base; P2-08)', () => {
  // A separate bugfix change: schema `crucible-bugfix`, one reproduction oracle
  // (marked `reproduces: true`) binding a REQ carried in its own spec delta so the
  // traceability lint stays green. The reproduction target reuses a resolvable toy
  // target so the injected resolver is happy.
  const BUGFIX = 'fix-greeting';
  const BUGFIX_REL = join('openspec', 'changes', BUGFIX);

  const BUGFIX_SPEC = `# greeting

## ADDED Requirements

### Requirement: Greeting rejects null bytes [REQ-greeting-nullbyte-9]

The system SHALL strip embedded null bytes before greeting.

#### Scenario: A name contains a null byte

- **WHEN** \`greet("a\\u0000b")\` is called
- **THEN** it returns \`Hello, ab!\`
`;

  const BUGFIX_ORACLES = `# Oracles — fix-greeting

## ORC-greeting-repro-001: Null byte is stripped (reproduction)
**Given** a name with an embedded null byte
**When** \`greet(name)\` is called
**Then** the null byte is stripped

\`\`\`yaml crucible-binding
requirement: REQ-greeting-nullbyte-9
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
reproduces: true
\`\`\`
`;

  /** Scaffold the bugfix bundle in scratch (pins the crucible-bugfix schema). */
  function writeBugfix(): void {
    const dir = join(scratch, BUGFIX_REL, 'specs', 'greeting');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(scratch, BUGFIX_REL, '.openspec.yaml'), 'schema: crucible-bugfix\n', 'utf8');
    writeFileSync(join(scratch, BUGFIX_REL, 'oracles.md'), BUGFIX_ORACLES, 'utf8');
    writeFileSync(join(dir, 'spec.md'), BUGFIX_SPEC, 'utf8');
  }

  /** A runOnBase spy returning the given base status for every reproduction oracle. */
  function runOnBaseWith(status: 'pass' | 'fail'): {
    runOnBase: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
    seen: string[];
  } {
    const seen: string[] = [];
    return {
      seen,
      runOnBase: (oracles) => {
        for (const o of oracles) seen.push(o.id);
        return Promise.resolve(
          oracles.map((o): OracleResult => ({
            oracleId: o.id,
            requirement: o.binding.requirement,
            status,
            targets: o.binding.targets.map((t) => ({ target: t, status })),
          })),
        );
      },
    };
  }

  it('reproduction FAILS on base → green: the fixture bugfix passes (acceptance)', async () => {
    writeBugfix();
    const { runOnBase, seen } = runOnBaseWith('fail');
    const report = await verify({ root: scratch, change: BUGFIX }, deps({ runOnBase }));
    expect(report.verdict).toBe('pass');
    const repro = report.checks.find((c) => c.name === 'reproduction');
    expect(repro?.status).toBe('pass');
    // ONLY the reproduction oracle was run on base (green-on-fix is the HEAD run).
    expect(seen).toEqual(['ORC-greeting-repro-001']);
  });

  it('reproduction PASSES on base → red "does not reproduce" (exit-worthy 1)', async () => {
    writeBugfix();
    const { runOnBase } = runOnBaseWith('pass');
    const report = await verify({ root: scratch, change: BUGFIX }, deps({ runOnBase }));
    expect(report.verdict).toBe('fail');
    const repro = report.checks.find((c) => c.name === 'reproduction');
    expect(repro?.status).toBe('fail');
    expect(repro?.findings[0]?.id).toBe('ORC-greeting-repro-001');
    expect(repro?.findings[0]?.message).toContain('does not reproduce');
    // The HEAD oracle run is unaffected — the red is purely the base run.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('pass');
  });

  it('reproduction FAILS on head → normal red via the ordinary oracles check', async () => {
    writeBugfix();
    // runFirstFails makes the HEAD oracle run red; the base run still reproduces.
    const { runOnBase } = runOnBaseWith('fail');
    const report = await verify(
      { root: scratch, change: BUGFIX },
      deps({ run: runFirstFails, runOnBase }),
    );
    expect(report.verdict).toBe('fail');
    // green-on-fix failed: the ordinary oracles check is the red source.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('fail');
    // red-on-base still held (the reproduction did fail on base).
    expect(report.checks.find((c) => c.name === 'reproduction')?.status).toBe('pass');
  });

  it('a FEATURE change never runs the reproduction check (bugfix-only)', async () => {
    // add-greeting is a feature; runOnBase must not be consulted for it.
    const runOnBase = (): Promise<OracleResult[]> => {
      throw new Error('runOnBase must not be called for a feature change');
    };
    const report = await verify({ root: scratch, change: CHANGE }, deps({ runOnBase }));
    expect(report.checks.some((c) => c.name === 'reproduction')).toBe(false);
  });

  it('without runOnBase, a bugfix runs the P1 checks only (inner-loop verify)', async () => {
    writeBugfix();
    const report = await verify({ root: scratch, change: BUGFIX }, deps());
    expect(report.verdict).toBe('pass');
    expect(report.checks.some((c) => c.name === 'reproduction')).toBe(false);
  });

  it('a red lint short-circuits the base run too (no worktree for unresolved bindings)', async () => {
    writeBugfix();
    const runOnBase = (): Promise<OracleResult[]> => {
      throw new Error('runOnBase must not run when the traceability gate is red');
    };
    const report = await verify(
      { root: scratch, change: BUGFIX },
      deps({ resolve: resolveAllMissing, run: runNeverCalled, runOnBase }),
    );
    expect(report.verdict).toBe('fail');
    expect(report.checks.some((c) => c.name === 'reproduction')).toBe(false);
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

describe('verify — adversarial reviewer input (P2-10, design phase-2.md §5)', () => {
  /** A canned review edge — what the CLI wires from `commands/review.ts`. */
  const greenReview = () =>
    Promise.resolve({
      check: { name: 'review', status: 'pass', findings: [] } as CheckResult,
      review: {
        rubric_hash: 'c'.repeat(64),
        model: 'claude-haiku-4-5-20251001',
        observations: [{ note: 'Retry idempotency is untested.' }],
      },
    });

  const redReview = () =>
    Promise.resolve({
      check: {
        name: 'review',
        status: 'fail',
        findings: [
          {
            check: 'review',
            id: 'R-002',
            message: 'Tolerance widened — src/greeting.ts:14; fix: restore exact comparison',
          },
        ],
      } as CheckResult,
      review: { rubric_hash: 'c'.repeat(64), observations: [] },
    });

  it('with the review edge supplied, the report carries a `review` check + observations extras', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps({ review: greenReview }));
    expect(report.verdict).toBe('pass');
    expect(report.checks.some((c) => c.name === 'review')).toBe(true);
    expect(report.review?.observations).toEqual([{ note: 'Retry idempotency is untested.' }]);
    expect(() => verifyReportSchema.parse(report)).not.toThrow();
  });

  it('a reviewer block is a red verdict like any other failing check', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps({ review: redReview }));
    expect(report.verdict).toBe('fail');
    const check = report.checks.find((c) => c.name === 'review');
    expect(check?.status).toBe('fail');
    expect(check?.findings[0]?.id).toBe('R-002');
  });

  it('without the review edge, no review check runs (optional locally: `verify --review`)', async () => {
    const report = await verify({ root: scratch, change: CHANGE }, deps());
    expect(report.checks.some((c) => c.name === 'review')).toBe(false);
    expect(report.review).toBeUndefined();
  });

  it('a red lint short-circuits the review edge (no agent run against an unparseable bundle)', async () => {
    const reviewNeverCalled = (): never => {
      throw new Error('deps.review must not be called when the traceability gate is red');
    };
    const report = await verify(
      { root: scratch, change: CHANGE },
      deps({ resolve: resolveAllMissing, run: runNeverCalled, review: reviewNeverCalled }),
    );
    expect(report.verdict).toBe('fail');
    expect(report.checks.some((c) => c.name === 'review')).toBe(false);
  });
});
