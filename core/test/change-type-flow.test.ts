import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../src/util/errors.js';
import type { ResolveFn, TargetResolution } from '../src/lint/traceability.js';
import type { Oracle } from '../src/artifacts/oracles.js';
import type { OracleResult } from '../src/adapters/types.js';
import { FakeSubstrate } from '../src/substrate/fake.js';
import { loadEnforcementConfig } from '../src/config/enforcement.js';
import { readChangeType } from '../src/changetype/changetype.js';
import { parseState } from '../src/state/state.js';
import { propose } from '../src/commands/propose.js';
import { approve } from '../src/commands/approve.js';
import { implement } from '../src/commands/implement.js';
import { verify, type DiffFacts } from '../src/commands/verify.js';

// P2-07 acceptance: the REFACTOR change type flows end-to-end on the regression
// suite ALONE (no spec delta, no new oracles), a refactor that smuggles in a spec
// delta fails closed (exit 3), and the type is recorded + revalidated like tier.

const CHANGE = 'tidy-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

// One archived promise so the regression suite is NON-empty — a refactor's whole
// correctness criterion. Its target resolves + passes under the fakes below.
const ARCHIVED_ORACLE = `# Oracles

## ORC-greeting-001: Greeting returns hello for a name
**Given** a name
**When** \`greet(name)\` is called
**Then** it returns "Hello, <name>!"

\`\`\`yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
\`\`\`
`;

// A conformant refactor bundle: proposal + design + an EMPTY oracles.md. No specs.
const REFACTOR_PROPOSAL = `# Proposal: tidy greeting

## Why
The greeting module has grown tangled; tidy it without changing behavior.

## What Changes
- Extract the formatting helper. No behavior change.

## Impact
- src/greeting.ts

## Unspecified
None known.

## Seams
None known.
`;
const REFACTOR_DESIGN = `# Design

## Context
The greeting logic is inlined. Extract it.

## Behavior Preservation
The regression suite pins greet()'s output; it must stay green.
`;
const EMPTY_ORACLES = `# Oracles

<!-- A refactor adds no new oracles. Correctness is the regression suite. -->
`;
// A well-formed spec delta — the thing a refactor is forbidden to carry.
const A_SPEC_DELTA = `# Spec delta: greeting

## ADDED Requirements

### Requirement: New promise [REQ-greeting-new-9]
The system SHALL do something new.

#### Scenario: it happens
- **WHEN** invoked
- **THEN** it does the new thing
`;

function refactorBundle(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [join(CHANGE_REL, 'proposal.md')]: REFACTOR_PROPOSAL,
    [join(CHANGE_REL, 'design.md')]: REFACTOR_DESIGN,
    [join(CHANGE_REL, 'oracles.md')]: EMPTY_ORACLES,
    ...extra,
  };
}

/** Resolver: every requested target is `found` (with a dummy file for hashing). */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((t): TargetResolution => ({ target: t, status: 'found', targetFile: 'src/greeting.ts' })),
  );

/** Runner: every oracle (here, only the archived one) passes. */
const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: 'pass',
      targets: o.binding.targets.map((t) => ({ target: t, status: 'pass' as const })),
    })),
  );

let scratch: string;
let now: () => string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-ct-flow-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // Start without the feature change; we author a refactor instead.
  rmSync(join(scratch, 'openspec', 'changes', 'add-greeting'), { recursive: true, force: true });
  // Seed one archived promise → the regression suite is non-empty.
  const arch = join(scratch, 'openspec', 'changes', 'archive', '2026-07-01-add-greeting');
  mkdirSync(arch, { recursive: true });
  writeFileSync(join(arch, 'oracles.md'), ARCHIVED_ORACLE);
  now = tickingClock();
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}Z`;
}

/** A scaffolder that writes .openspec.yaml pinned to the passed schema. */
function fakeScaffold(root: string): (change: string, schema: string) => Promise<void> {
  return (change, schema) => {
    const dir = join(root, 'openspec', 'changes', change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.openspec.yaml'), `schema: ${schema}\ncreated: 2026-07-24\n`);
    return Promise.resolve();
  };
}

function diffFacts(): DiffFacts {
  return { touchedPaths: ['src/greeting.ts'], diffLines: 12 };
}

async function doProposeRefactor(files: Record<string, string>, type?: 'refactor' | 'feature') {
  return propose(
    { root: scratch, change: CHANGE, intent: 'Refactor the greeting module', model: 'm', ...(type ? { type } : {}) },
    { substrate: new FakeSubstrate({ files }), scaffold: fakeScaffold(scratch), resolve: resolveAllFound, now },
  );
}

describe('refactor change type — end to end on the regression suite alone', () => {
  it('propose infers refactor from intent and pins the crucible-refactor schema', async () => {
    const result = await doProposeRefactor(refactorBundle());
    expect(result.report.verdict).toBe('pass');
    expect(result.type).toBe('refactor');
    expect(readChangeType(join(scratch, CHANGE_REL))).toBe('refactor');
  });

  it('records the change type in the state snapshot (recorded like tier)', async () => {
    await doProposeRefactor(refactorBundle());
    const state = parseState(readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8'), 'state');
    expect(state.snapshot.change_type).toBe('refactor');
  });

  it('flows propose → approve → implement → verify green, correctness = regression suite', async () => {
    const proposed = await doProposeRefactor(refactorBundle());
    expect(proposed.report.verdict).toBe('pass');

    const approved = await approve(
      { root: scratch, change: CHANGE, yes: true },
      {
        resolve: resolveAllFound,
        confirm: () => Promise.reject(new Error('no prompt under --yes')),
        now,
        approvedBy: () => 'ada@example.com',
      },
    );
    expect(approved.approved).toBe(true);

    const implemented = await implement(
      { root: scratch, change: CHANGE, model: 'm' },
      {
        substrate: new FakeSubstrate(() => ({
          files: { [join(CHANGE_REL, 'tasks.md')]: '# Tasks\n\n- [ ] 1.1 extract helper\n' },
        })),
        resolve: resolveAllFound,
        run: runAllPass,
        now,
      },
    );
    expect(implemented.report.verdict).toBe('pass');

    // Standalone authority verify with enforcement config + diff facts.
    const report = await verify(
      { root: scratch, change: CHANGE, config: loadEnforcementConfig(scratch) },
      { resolve: resolveAllFound, run: runAllPass, diffFacts },
    );
    expect(report.verdict).toBe('pass');
    // No current-change oracles; the regression check carries correctness.
    expect(report.checks.map((c) => c.name)).toContain('regression');
    const regression = report.checks.find((c) => c.name === 'regression')!;
    expect(regression.status).toBe('pass');
  });
});

describe('refactor conformance — fail closed (exit 3)', () => {
  it('a refactor bundle carrying a spec delta is exit 3 at propose', async () => {
    const err = await captureThrow(() =>
      doProposeRefactor(refactorBundle({ [join(CHANGE_REL, 'specs', 'greeting', 'spec.md')]: A_SPEC_DELTA })),
    );
    expect(isCrucibleError(err) && err.exit).toBe(3);
    expect((err as Error).message).toContain('spec delta');
  });

  it('verify revalidates the type: a sealed refactor that grows a spec delta is exit 3', async () => {
    await doProposeRefactor(refactorBundle());
    await approve(
      { root: scratch, change: CHANGE, yes: true },
      {
        resolve: resolveAllFound,
        confirm: () => Promise.resolve(true),
        now,
        approvedBy: () => 'ada@example.com',
      },
    );
    // Someone drops a spec delta into the sealed refactor bundle.
    mkdirSync(join(scratch, CHANGE_REL, 'specs', 'greeting'), { recursive: true });
    writeFileSync(join(scratch, CHANGE_REL, 'specs', 'greeting', 'spec.md'), A_SPEC_DELTA);

    const err = await captureThrow(() =>
      verify(
        { root: scratch, change: CHANGE, config: loadEnforcementConfig(scratch) },
        { resolve: resolveAllFound, run: runAllPass, diffFacts },
      ),
    );
    expect(isCrucibleError(err) && err.exit).toBe(3);
  });
});

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}
