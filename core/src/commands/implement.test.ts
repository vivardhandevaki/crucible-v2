import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { FakeSubstrate, type FakeScript } from '../substrate/fake.js';
import { implement, type ImplementDeps } from './implement.js';

// `implement` is the first command on the *approved* side of the gate (charter
// §Tasks live on the other side of the gate). Its two load-bearing guarantees
// are structural, and both are exercised here with the FakeSubstrate: it refuses
// without a valid approval (invariant 5 — no seal / void seal → exit 2), and it
// generates tasks.md as its FIRST action, verified on disk before any implement
// session runs (invariant 2 — the agent's claim is worth zero). Everything
// non-deterministic (substrate, resolver, oracle runner, clock) is injected
// (invariant 12); the final report is a local `verify` (P1-12) whose red verdict
// is a returned verdict (exit 1 at the CLI), never a throw.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const TASKS_REL = join(CHANGE_REL, 'tasks.md');
const FROZEN_NOW = '2026-07-23T00:00:00Z';

// The toy repo's two oracle targets → the files they live in (tests.json).
const TARGET_FILES: Record<string, string> = {
  'greeting::returns_hello_for_a_name': 'tests/greeting.test.ts',
  'greeting::defaults_to_world_when_empty': 'tests/greeting.test.ts',
};

// The approval hash scope for the toy bundle (mirrors approve's computeHashScope):
// the core artifacts, the one spec delta, and the one bound test file.
const SEALED_SCOPE = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  join('tests', 'greeting.test.ts'),
];

/** A resolver that marks every requested target `found` with its file. */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => {
      const targetFile = TARGET_FILES[target];
      return targetFile !== undefined
        ? { target, status: 'found', targetFile }
        : { target, status: 'missing' };
    }),
  );

/** An oracle runner that passes every bound target (the green verify path). */
const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o) => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: 'pass' as const,
      targets: o.binding.targets.map((t) => ({ target: t, status: 'pass' as const })),
    })),
  );

let scratch: string;
let events: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-implement-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // implement generates tasks.md itself: start from a bundle without one.
  rmSync(join(scratch, TASKS_REL), { force: true });
  events = [];
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Seal the toy bundle so implement's approval precondition is satisfied. */
function sealApproval(): void {
  const approval = sealBundle(scratch, SEALED_SCOPE, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: FROZEN_NOW,
  });
  writeFileSync(join(scratch, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}

/**
 * A two-session substrate: the first call writes `tasksFiles` (the work
 * breakdown), the second writes `implFiles` (the implementation). Each records
 * an ordered event, and the second call captures whether tasks.md already
 * existed — the direct proof of "tasks.md before implementation artifacts".
 */
const probe: { tasksMdAtImplement?: boolean } = {};
function twoSessionSubstrate(
  tasksFiles: Record<string, string> = { [TASKS_REL]: '# Tasks\n\n- [ ] implement greet\n' },
  implFiles: Record<string, string> = { 'src/impl.ts': 'export const impl = true;\n' },
): FakeSubstrate {
  let call = 0;
  return new FakeSubstrate((): FakeScript => {
    call += 1;
    if (call === 1) {
      events.push('tasks-session');
      return { files: tasksFiles };
    }
    events.push('implement-session');
    probe.tasksMdAtImplement = existsSync(join(scratch, TASKS_REL));
    return { files: implFiles };
  });
}

function deps(overrides: Partial<ImplementDeps> = {}): ImplementDeps {
  return {
    substrate: twoSessionSubstrate(),
    resolve: resolveAllFound,
    run: runAllPass,
    now: () => FROZEN_NOW,
    ...overrides,
  };
}

function options(
  over: Partial<Parameters<typeof implement>[0]> = {},
): Parameters<typeof implement>[0] {
  return { root: scratch, change: CHANGE, model: 'claude-opus-4-8', ...over };
}

/** Capture the CrucibleError a call throws, or fail the test loudly. */
async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

beforeEach(() => {
  delete probe.tasksMdAtImplement;
});

describe('implement — refuses without a valid approval (invariant 5, charter)', () => {
  it('refuses when no approval.yaml exists (exit 2, names `crucible approve`)', async () => {
    const err = await catchCrucible(() => implement(options(), deps()));
    expect(err.exit).toBe(2);
    expect(err.hint).toContain('crucible approve');
    // No session ran — the gate refused before any substrate call.
    expect(events).toEqual([]);
  });

  it('refuses on a void seal, listing the mismatched files (exit 2)', async () => {
    sealApproval();
    // Tamper with a sealed file *after* approval — the exact escape invariant 6
    // exists to catch.
    appendFileSync(join(scratch, 'tests', 'greeting.test.ts'), '\n// tampered post-approval\n');
    const err = await catchCrucible(() => implement(options(), deps()));
    expect(err.exit).toBe(2);
    expect(err.message).toContain(join('tests', 'greeting.test.ts'));
    expect(err.hint).toContain('crucible approve');
    expect(events).toEqual([]);
  });

  it('refuses when the implement role prompt is missing (exit 2 naming the path)', async () => {
    sealApproval();
    rmSync(join(scratch, '.crucible', 'context', 'implement.md'));
    const err = await catchCrucible(() => implement(options(), deps()));
    expect(err.exit).toBe(2);
    expect(err.message).toContain(join('.crucible', 'context', 'implement.md'));
    expect(events).toEqual([]);
  });
});

describe('implement — tasks.md is the first action (charter, invariant 2)', () => {
  beforeEach(sealApproval);

  it('generates tasks.md before the implementation artifacts', async () => {
    const result = await implement(options(), deps());
    // Sessions ran in order: tasks first, then implement.
    expect(events).toEqual(['tasks-session', 'implement-session']);
    // tasks.md already existed when the implement session ran (the structural proof).
    expect(probe.tasksMdAtImplement).toBe(true);
    // Both artifacts are on disk afterwards.
    expect(existsSync(join(scratch, TASKS_REL))).toBe(true);
    expect(existsSync(join(scratch, 'src', 'impl.ts'))).toBe(true);
    expect(result.report.verdict).toBe('pass');
  });

  it('fails closed (exit 3) when the tasks session produces no tasks.md', async () => {
    const err = await catchCrucible(() =>
      implement(options(), deps({ substrate: twoSessionSubstrate({}, {}) })),
    );
    expect(err.exit).toBe(3);
    expect(err.message).toContain(TASKS_REL);
    // The implement session never ran — the gate stopped after tasks failed.
    expect(events).toEqual(['tasks-session']);
  });

  it('runs each session fresh-context with the implement role contract (invariant 10)', async () => {
    const d = deps();
    await implement(options(), d);
    const sub = d.substrate as FakeSubstrate;
    expect(sub.calls).toHaveLength(2);
    for (const req of sub.calls) {
      expect(req.role).toBe('implement');
      expect(req.cwd).toBe(scratch);
      expect(req.model).toBe('claude-opus-4-8');
      expect(req.rolePromptPath).toBe(join(scratch, '.crucible', 'context', 'implement.md'));
    }
    // The two transcripts are distinct so one clock tick cannot collide them.
    expect(sub.calls[0]!.transcriptPath).not.toBe(sub.calls[1]!.transcriptPath);
  });
});

describe('implement — local verify report (design §6)', () => {
  beforeEach(sealApproval);

  it('returns a green verify report on the happy path', async () => {
    const result = await implement(options(), deps());
    expect(result.report.verdict).toBe('pass');
    expect(result.report.checks.map((c) => c.name)).toEqual([
      'traceability',
      'oracles',
      'approval',
    ]);
    expect(result.render).toContain(`implement ${CHANGE}: PASS`);
  });

  it('reports a red verdict (not a throw) when an oracle fails', async () => {
    const runOneFail = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
      Promise.resolve(
        oracles.map((o, i) => ({
          oracleId: o.id,
          requirement: o.binding.requirement,
          status: i === 0 ? ('fail' as const) : ('pass' as const),
          targets: o.binding.targets.map((t) => ({
            target: t,
            status: i === 0 ? ('fail' as const) : ('pass' as const),
          })),
        })),
      );
    const result = await implement(options(), deps({ run: runOneFail }));
    expect(result.report.verdict).toBe('fail');
    const oracles = result.report.checks.find((c) => c.name === 'oracles')!;
    expect(oracles.status).toBe('fail');
  });

  it('an implement session that edits a sealed test file → red approval check (invariant 6)', async () => {
    // The implement session overwrites a sealed bound test file — verify's
    // approval-hash check must catch it as a red verdict (exit 1), not a throw.
    const substrate = twoSessionSubstrate(
      { [TASKS_REL]: '# Tasks\n\n- [ ] implement greet\n' },
      { [join('tests', 'greeting.test.ts')]: '// gutted by the implement session\n' },
    );
    const result = await implement(options(), deps({ substrate }));
    expect(result.report.verdict).toBe('fail');
    const approval = result.report.checks.find((c) => c.name === 'approval')!;
    expect(approval.status).toBe('fail');
    expect(approval.findings.some((f) => f.id === join('tests', 'greeting.test.ts'))).toBe(true);
  });
});

describe('implement — state events (invariant 1: audit, appended in order)', () => {
  beforeEach(sealApproval);

  it('appends a tasks event then a verify event, in order', async () => {
    await implement(options(), deps());
    const state = readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8');
    const tasksAt = state.indexOf('tasks.md generated');
    const verifyAt = state.indexOf('local verify pass');
    expect(tasksAt).toBeGreaterThanOrEqual(0);
    expect(verifyAt).toBeGreaterThan(tasksAt);
  });

  it('still records the audit trail on a red verdict (never gates on it)', async () => {
    const runFail = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
      Promise.resolve(
        oracles.map((o) => ({
          oracleId: o.id,
          requirement: o.binding.requirement,
          status: 'fail' as const,
          targets: o.binding.targets.map((t) => ({ target: t, status: 'fail' as const })),
        })),
      );
    await implement(options(), deps({ run: runFail }));
    const state = readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8');
    expect(state).toContain('local verify fail');
    expect(state).toContain('implement-red');
  });
});
