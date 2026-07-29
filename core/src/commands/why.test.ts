import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import type { CheckResult, ReviewReport } from '../verifyx/report.js';
import { why, renderWhy, type WhyDeps } from './why.js';

// P2-16: `crucible why <id>` walks a verify failure back to its source
// (design phase-2.md §8 L108: report → oracle → binding → adapter output →
// raw tool output path; reviewer findings → rubric line + evidence + fix).
// Acceptance: each failure class in the P1-16 tracer negatives is traceable to
// its source WITH FILE PATHS; an unknown id → exit 2 with the available ids.
//
// Determinism (invariant 12): `why` runs the real verify core through the same
// injected resolver/runner edges — the core spawns no adapter, so these tests
// drive it with pure functions.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const ORACLES_REL = join(CHANGE_REL, 'oracles.md');
const SPEC_REL = join(CHANGE_REL, 'specs', 'greeting', 'spec.md');

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

/** Runner: ORC-greeting-001 reports its bound target `skip` (invariant 4 → fail),
 * carrying a raw tool `location` — the "raw tool output path" the trace surfaces. */
const runFirstSkips = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o): OracleResult => {
      const skipped = o.id === 'ORC-greeting-001';
      return {
        oracleId: o.id,
        requirement: o.binding.requirement,
        status: skipped ? 'fail' : 'pass',
        targets: o.binding.targets.map((t) => ({
          target: t,
          status: skipped ? ('skip' as const) : ('pass' as const),
          ...(skipped
            ? {
                message: 'localization not implemented; skipped',
                location: 'tests/greeting.test.ts:42',
              }
            : {}),
        })),
      };
    }),
  );

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-why-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function deps(overrides: Partial<WhyDeps> = {}): WhyDeps {
  return { resolve: resolveAllFound, run: runAllPass, ...overrides };
}

/** Seal an approval.yaml over the bundle + its bound test file. */
function writeApproval(): void {
  const relpaths = [
    join(CHANGE_REL, 'proposal.md'),
    join(CHANGE_REL, 'design.md'),
    ORACLES_REL,
    SPEC_REL,
    'tests/greeting.test.ts',
  ];
  const approval = sealBundle(scratch, relpaths, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: '2026-07-23T00:00:00Z',
  });
  writeFileSync(join(scratch, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}

/** Capture the CrucibleError a call throws, or fail loudly. */
async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('why — tracer negative 1: REQ without an oracle (traceability class)', () => {
  it('traces a requirement to its spec source and names the missing coverage', async () => {
    // Append an uncovered requirement — the exact P1-16 "a requirement without an
    // oracle is a wish" red, landing on the traceability check.
    appendFileSync(
      join(scratch, SPEC_REL),
      '\n### Requirement: Localized greeting [REQ-greeting-localized-3]\n\n' +
        'The system SHALL greet in the configured locale.\n',
    );

    const trace = await why(
      { root: scratch, change: CHANGE, id: 'REQ-greeting-localized-3' },
      deps(),
    );
    expect(trace.kind).toBe('requirement');
    expect(trace.status).toBe('fail');
    // Source with a file path: the spec delta the requirement lives in.
    const src = trace.steps.find((s) => s.source?.startsWith(SPEC_REL));
    expect(src).toBeDefined();
    const rendered = renderWhy(trace);
    expect(rendered).toContain(SPEC_REL);
    expect(rendered).toContain('REQ-greeting-localized-3');
    expect(rendered.toLowerCase()).toContain('no oracle');
  });
});

describe('why — tracer negative 2: a skipped oracle test (oracles class)', () => {
  it('traces oracle → binding → adapter output → raw tool output path', async () => {
    writeApproval();
    const trace = await why(
      { root: scratch, change: CHANGE, id: 'ORC-greeting-001' },
      deps({ run: runFirstSkips }),
    );
    expect(trace.kind).toBe('oracle');
    expect(trace.status).toBe('fail');

    const rendered = renderWhy(trace);
    // check → oracle: the oracle's own source (oracles.md + heading line).
    expect(trace.steps.some((s) => s.source?.startsWith(ORACLES_REL))).toBe(true);
    // oracle → requirement: the REQ it binds, at its spec source.
    expect(rendered).toContain('REQ-greeting-basic-1');
    // binding → adapter target.
    expect(rendered).toContain('greeting::returns_hello_for_a_name');
    // adapter output → resolved test file AND the raw tool output location.
    expect(rendered).toContain('tests/greeting.test.ts');
    expect(rendered).toContain('tests/greeting.test.ts:42');
    // The invariant-4 provenance: skip is why this is red, not a test failure.
    expect(rendered).toContain('skip');
  });

  it('traces a passing oracle too (why is not only for red)', async () => {
    const trace = await why({ root: scratch, change: CHANGE, id: 'ORC-greeting-002' }, deps());
    expect(trace.kind).toBe('oracle');
    expect(trace.status).toBe('pass');
    expect(renderWhy(trace)).toContain('greeting::defaults_to_world_when_empty');
  });
});

describe('why — tracer negative 3: a post-approval oracle edit (approval class)', () => {
  it('traces a voided seal to the exact file that changed', async () => {
    writeApproval();
    // The escape the seal exists to catch: an oracle edited after approval.
    appendFileSync(join(scratch, ORACLES_REL), '\n<!-- sharpened after approval -->\n');

    const trace = await why({ root: scratch, change: CHANGE, id: ORACLES_REL }, deps());
    expect(trace.kind).toBe('seal');
    expect(trace.status).toBe('fail');
    // Source with a file path: the sealed file whose hash no longer matches.
    expect(trace.steps.some((s) => s.source === ORACLES_REL)).toBe(true);
    const rendered = renderWhy(trace);
    expect(rendered).toContain(ORACLES_REL);
    expect(rendered.toLowerCase()).toContain('approval');
  });
});

describe('why — reviewer findings (rubric class)', () => {
  it('traces a rubric id to its line in the reviewer law', async () => {
    const trace = await why({ root: scratch, change: CHANGE, id: 'R-001' }, deps());
    expect(trace.kind).toBe('rubric');
    // No review ran → the line itself is surfaced (its criterion + evidence).
    const rendered = renderWhy(trace);
    expect(rendered).toContain('R-001');
    expect(rendered).toContain('Vacuous or tautological test assertions');
    expect(rendered).toContain(join('.crucible', 'rubric.yaml'));
  });

  it('shows evidence + remediation when the last review blocked on the line', async () => {
    const reviewCheck: CheckResult = {
      name: 'review',
      status: 'fail',
      findings: [
        {
          check: 'review',
          id: 'R-001',
          message:
            'the assertion passes regardless of behavior — src/greeting.ts:7; fix: assert the actual output',
        },
      ],
    };
    const reviewReport: ReviewReport = { rubric_hash: 'deadbeef', observations: [] };
    const trace = await why(
      { root: scratch, change: CHANGE, id: 'R-001' },
      deps({ review: () => Promise.resolve({ check: reviewCheck, review: reviewReport }) }),
    );
    expect(trace.kind).toBe('rubric');
    expect(trace.status).toBe('fail');
    const rendered = renderWhy(trace);
    expect(rendered).toContain('src/greeting.ts:7');
    expect(rendered.toLowerCase()).toContain('fix:');
  });
});

describe('why — unknown id', () => {
  it('exits 2 and lists the available ids', async () => {
    const err = await catchCrucible(() =>
      why({ root: scratch, change: CHANGE, id: 'NOPE-999' }, deps()),
    );
    expect(err.exit).toBe(2);
    // The available-ids surface must name real, addressable subjects.
    const surfaced = `${err.message}\n${err.hint}`;
    expect(surfaced).toContain('ORC-greeting-001');
    expect(surfaced).toContain('REQ-greeting-basic-1');
    expect(surfaced).toContain('R-001');
  });

  it('a missing change bundle bubbles the verify precondition (exit 2)', async () => {
    const err = await catchCrucible(() =>
      why({ root: scratch, change: 'no-such-change', id: 'anything' }, deps()),
    );
    expect(err.exit).toBe(2);
  });
});
