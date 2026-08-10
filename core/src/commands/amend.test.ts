import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import type { NotifyEvent } from '../notify/types.js';
import { loadApproval, parseApproval, verifyApproval } from '../artifacts/approval.js';
import {
  buildEscalation,
  serializeEscalation,
  ESCALATION_VERSION,
} from '../artifacts/escalation.js';
import { FakeSubstrate, type FakeScript } from '../substrate/fake.js';
import { approve } from './approve.js';
import { implement } from './implement.js';
import { amend, type AmendDeps } from './amend.js';

// P2-05: `amend` is the post-approval spec-fix / escalation-resolution path
// (charter §Approval, Amend, Override; §Escalation layer 2). It regenerates
// through the propose role (invariant 2 — judged, not trusted), appends a delta
// entry with fresh hashes to approval.yaml, and clears any escalation so
// implement resumes. Everything non-deterministic (substrate, resolver, confirm,
// clock, identity, notify) is injected (invariant 12).

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const DESIGN_REL = join(CHANGE_REL, 'design.md');
const ORACLES_REL = join(CHANGE_REL, 'oracles.md');
const APPROVAL_REL = join(CHANGE_REL, 'approval.yaml');
const ESCALATION_REL = join(CHANGE_REL, 'escalation.yaml');

const TARGET_FILES: Record<string, string> = {
  'greeting::returns_hello_for_a_name': 'tests/greeting.test.ts',
  'greeting::defaults_to_world_when_empty': 'tests/greeting.test.ts',
};

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

/** An oracle runner that passes every bound target (for implement's verify). */
const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: 'pass',
      targets: o.binding.targets.map((target) => ({ target, status: 'pass' })),
    })),
  );

let scratch: string;
let events: NotifyEvent[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-amend-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  events = [];
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Seal the toy bundle so amend has an approved seal to delta from. */
async function sealToyBundle(): Promise<void> {
  await approve(
    { root: scratch, change: CHANGE, yes: true },
    {
      resolve: resolveAllFound,
      confirm: () => Promise.reject(new Error('no confirm under --yes')),
      now: () => '2026-07-25T00:00:00Z',
      approvedBy: () => 'ada@example.com',
    },
  );
}

/** Write a valid escalation.yaml into the bundle (as `crucible escalate` would). */
function fileEscalation(): void {
  const esc = buildEscalation({
    version: ESCALATION_VERSION,
    change: CHANGE,
    oracle: 'ORC-greeting-002',
    question: 'greeting for a whitespace-only name is unspecified',
    options: ['treat as empty → Hello, world!', 'error out'],
    filed_by: 'implement@crucible',
    filed_at: '2026-07-25T01:00:00Z',
  });
  writeFileSync(join(scratch, ESCALATION_REL), serializeEscalation(esc), 'utf8');
}

/** A substrate that rewrites design.md — a coherent, lint-green regeneration. */
function regenSubstrate(
  newDesign = '# Design — add-greeting (amended)\n\nResolved.\n',
): FakeSubstrate {
  return new FakeSubstrate({ files: { [DESIGN_REL]: newDesign } } satisfies FakeScript);
}

function deps(over: Partial<AmendDeps> = {}): AmendDeps {
  return {
    substrate: regenSubstrate(),
    resolve: resolveAllFound,
    confirm: () => Promise.resolve(true),
    now: () => '2026-07-25T02:00:00Z',
    amendedBy: () => 'ada@example.com',
    notify: (e) => {
      events.push(e);
    },
    ...over,
  };
}

function opts(over: Partial<Parameters<typeof amend>[0]> = {}): Parameters<typeof amend>[0] {
  return {
    root: scratch,
    change: CHANGE,
    resolution: 'treat as empty → Hello, world!',
    model: 'claude-opus-4-8',
    yes: true,
    ...over,
  };
}

async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('amend — escalation resolution end-to-end (P2-05 acceptance)', () => {
  it('resolves an escalation: regenerates, re-seals, clears it, implement resumes', async () => {
    await sealToyBundle();
    fileEscalation();
    const before = loadApproval(join(scratch, APPROVAL_REL));

    // Before amend: implement refuses to resume while the escalation is pending.
    const blocked = await catchCrucible(() =>
      implement(
        { root: scratch, change: CHANGE, model: 'm' },
        {
          substrate: new FakeSubstrate(),
          resolve: resolveAllFound,
          run: runAllPass,
          now: () => 't',
        },
      ),
    );
    expect(blocked.code).toBe('ESCALATION_PENDING');

    // amend picks the option and regenerates.
    const result = await amend(opts(), deps());
    expect(result.amended).toBe(true);
    expect(result.report.verdict).toBe('pass');
    // The changed-artifact diff surfaced design.md.
    expect(result.render).toContain(DESIGN_REL);

    // A delta entry with fresh hashes was appended; the live seal updated.
    const after = parseApproval(readFileSync(join(scratch, APPROVAL_REL), 'utf8'), 'approval.yaml');
    expect(after.amendments).toHaveLength(1);
    expect(after.amendments[0]!.at).toBe('2026-07-25T02:00:00Z');
    expect(after.files[DESIGN_REL]).not.toBe(before.files[DESIGN_REL]);
    // The original approver/approved_at survive — an amend is a delta, not a re-approval.
    expect(after.approved_by).toBe('ada@example.com');
    expect(after.approved_at).toBe('2026-07-25T00:00:00Z');

    // The escalation is cleared.
    expect(existsSync(join(scratch, ESCALATION_REL))).toBe(false);

    // implement now RESUMES — no ESCALATION_PENDING, and the seal is valid.
    const substrate = new FakeSubstrate((req) =>
      req.taskPayload.includes('work breakdown')
        ? { files: { [join(CHANGE_REL, 'tasks.md')]: '# Tasks\n\n- [ ] 1.1 done\n' } }
        : {},
    );
    const resumed = await implement(
      { root: scratch, change: CHANGE, model: 'm' },
      { substrate, resolve: resolveAllFound, run: runAllPass, now: () => 't' },
    );
    expect(resumed.report.verdict).toBe('pass');
  });

  it('post-amend hash verification passes (P2-05 acceptance)', async () => {
    await sealToyBundle();
    fileEscalation();
    await amend(opts(), deps());
    const approval = loadApproval(join(scratch, APPROVAL_REL));
    expect(verifyApproval(scratch, approval).valid).toBe(true);
  });

  it('a direct post-approval edit still voids the amended seal (P2-05 acceptance)', async () => {
    await sealToyBundle();
    fileEscalation();
    await amend(opts(), deps());

    // Hand-edit a sealed artifact after the amend re-seal — the seal must void.
    writeFileSync(
      join(scratch, ORACLES_REL),
      readFileSync(join(scratch, ORACLES_REL), 'utf8') + '\n<!-- tampered -->\n',
    );
    const approval = loadApproval(join(scratch, APPROVAL_REL));
    const verdict = verifyApproval(scratch, approval);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.mismatches).toContain(ORACLES_REL);
  });

  it('fires the notify hook on a successful amend (convenience, invariant 11)', async () => {
    await sealToyBundle();
    fileEscalation();
    await amend(opts(), deps());
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain('AMENDED');
  });

  it('a throwing notify hook never blocks the amend (convenience-never-enforcement)', async () => {
    await sealToyBundle();
    fileEscalation();
    const result = await amend(
      opts(),
      deps({
        notify: () => {
          throw new Error('webhook down');
        },
      }),
    );
    expect(result.amended).toBe(true);
    expect(existsSync(join(scratch, ESCALATION_REL))).toBe(false);
  });
});

describe('amend — general mid-flight spec fix (no escalation)', () => {
  it('re-seals with a fresh amendment when there is no escalation to clear', async () => {
    await sealToyBundle();
    const result = await amend(
      opts({ resolution: 'clarify the default greeting wording' }),
      deps(),
    );
    expect(result.amended).toBe(true);
    const after = parseApproval(readFileSync(join(scratch, APPROVAL_REL), 'utf8'), 'approval.yaml');
    expect(after.amendments).toHaveLength(1);
  });
});

describe('amend — a red regeneration re-seals nothing and keeps the escalation', () => {
  it('malformed regenerated oracles → red report, no re-seal, escalation intact', async () => {
    await sealToyBundle();
    fileEscalation();
    const before = readFileSync(join(scratch, APPROVAL_REL), 'utf8');
    const result = await amend(
      opts(),
      deps({
        substrate: new FakeSubstrate({
          files: { [ORACLES_REL]: '## ORC-BAD: no grammar, no fence\n' },
        }),
      }),
    );
    expect(result.amended).toBe(false);
    expect(result.report.verdict).toBe('fail');
    // The seal is untouched and the escalation is still pending.
    expect(readFileSync(join(scratch, APPROVAL_REL), 'utf8')).toBe(before);
    expect(existsSync(join(scratch, ESCALATION_REL))).toBe(true);
  });
});

describe('amend — declined confirm writes nothing', () => {
  it('a declined diff leaves the seal and the escalation as they were', async () => {
    await sealToyBundle();
    fileEscalation();
    const before = readFileSync(join(scratch, APPROVAL_REL), 'utf8');
    const result = await amend(
      opts({ yes: false }),
      deps({ confirm: () => Promise.resolve(false) }),
    );
    expect(result.amended).toBe(false);
    expect(readFileSync(join(scratch, APPROVAL_REL), 'utf8')).toBe(before);
    expect(existsSync(join(scratch, ESCALATION_REL))).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe('amend — preconditions (invariant 5)', () => {
  it('missing change bundle → exit 2 naming propose', async () => {
    const err = await catchCrucible(() => amend(opts({ change: 'no-such' }), deps()));
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('a not-yet-approved bundle → exit 2 (amend is the post-approval path)', async () => {
    // No sealToyBundle() call: approval.yaml is absent.
    const err = await catchCrucible(() => amend(opts(), deps()));
    expect(err.exit).toBe(2);
    expect(err.code).toBe('NO_APPROVAL');
  });

  it('an empty resolution → exit 2 (nothing to apply)', async () => {
    await sealToyBundle();
    const err = await catchCrucible(() => amend(opts({ resolution: '   ' }), deps()));
    expect(err.exit).toBe(2);
    expect(err.code).toBe('NO_RESOLUTION');
  });

  it('a malformed escalation.yaml fails closed at exit 3', async () => {
    await sealToyBundle();
    writeFileSync(join(scratch, ESCALATION_REL), 'version: 1\nchange: x\n'); // missing fields
    const err = await catchCrucible(() => amend(opts(), deps()));
    expect(err.exit).toBe(3);
  });
  it('accepts a legitimate post-approval tasks.md during headless regeneration', async () => {
    await sealToyBundle();
    writeFileSync(
      join(scratch, CHANGE_REL, 'tasks.md'),
      '# Tasks\n\n- [ ] Existing implementation work\n',
    );
    const result = await amend(opts(), deps());
    expect(result.amended).toBe(true);
    expect(result.report.verdict).toBe('pass');
  });
});
