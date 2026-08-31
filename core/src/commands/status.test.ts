import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { status, type StatusDeps, type StatusOptions } from './status.js';

// `status` is the on-demand dashboard (charter §State & Audit; design §9). It
// DERIVES the phase from the artifacts on disk — never from state.yaml's recorded
// phase (invariant 1) — prints the next command, and reconciles the derived audit
// trail (rewriting a corrupt or diverged state.yaml, preserving a consistent one).
// It runs no adapter and always exits 0 (invariant 11 — convenience, never a
// gate). The only non-deterministic edge (the merge-base config read) is injected
// (invariant 12).

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const TASKS_REL = join(CHANGE_REL, 'tasks.md');
const STATE_REL = join(CHANGE_REL, 'state.yaml');
const APPROVAL_REL = join(CHANGE_REL, 'approval.yaml');
const PROPOSAL_REL = join(CHANGE_REL, 'proposal.md');
const FROZEN_NOW = '2026-07-23T00:00:00Z';

// The approval hash scope for the toy bundle (mirrors approve's computeHashScope).
const SEALED_SCOPE = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  join('tests', 'greeting.test.ts'),
];

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-status-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // Start every case from a clean "just proposed" bundle: no seal, no tasks, no
  // state. Individual tests add exactly the artifacts for the stage they exercise.
  rmSync(join(scratch, APPROVAL_REL), { force: true });
  rmSync(join(scratch, TASKS_REL), { force: true });
  rmSync(join(scratch, STATE_REL), { force: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Seal the toy bundle so the approval precondition + hash check are satisfied. */
function sealApproval(): void {
  const approval = sealBundle(scratch, SEALED_SCOPE, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: FROZEN_NOW,
  });
  writeFileSync(join(scratch, APPROVAL_REL), serializeApproval(approval), 'utf8');
}

/** Write a tasks.md so the bundle reads as "implemented" (approval + tasks). */
function writeTasks(): void {
  writeFileSync(join(scratch, TASKS_REL), '# Tasks\n\n- [ ] implement greet\n', 'utf8');
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return { readMergeBaseConfig: () => undefined, ...overrides };
}

function options(over: Partial<StatusOptions> = {}): StatusOptions {
  return { root: scratch, change: CHANGE, ...over };
}

/** Capture the CrucibleError a call throws, or fail the test loudly. */
function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

describe('status — derives phase + next command at each fixture stage (design §9)', () => {
  it('absent: no change dir → propose is next', () => {
    const report = status(options({ change: 'no-such-change' }), deps());
    expect(report.phase).toBe('absent');
    expect(report.next).toContain('crucible propose');
    expect(report.next).toContain('no-such-change');
  });

  it('proposed: bundle parses, no seal → approve is next', () => {
    const report = status(options(), deps());
    expect(report.phase).toBe('proposed');
    expect(report.next).toBe(`crucible approve ${CHANGE}`);
  });

  it('approved: valid seal, no tasks.md → implement is next', () => {
    sealApproval();
    const report = status(options(), deps());
    expect(report.phase).toBe('approved');
    expect(report.next).toBe(`crucible implement ${CHANGE}`);
  });

  it('implemented: valid seal + tasks.md → verify is next', () => {
    sealApproval();
    writeTasks();
    const report = status(options(), deps());
    expect(report.phase).toBe('implemented');
    expect(report.next).toBe(`crucible verify ${CHANGE}`);
  });

  it('approval-void: a sealed file changed since approval → amend, mismatch named', () => {
    sealApproval();
    // Break the seal by appending to a sealed artifact.
    const proposal = join(scratch, PROPOSAL_REL);
    writeFileSync(proposal, readFileSync(proposal, 'utf8') + '\nedited after approval\n', 'utf8');
    const report = status(options(), deps());
    expect(report.phase).toBe('approval-void');
    expect(report.next).toBe(`crucible amend ${CHANGE}`);
    expect(report.voidMismatches).toContain(PROPOSAL_REL);
  });
});

describe('status — reads artifacts, never state.yaml, to decide (invariant 1)', () => {
  it('a state.yaml claiming a later phase does not change the derived phase', () => {
    // No seal exists, yet state claims "implemented". Artifacts win → "proposed".
    writeFileSync(join(scratch, STATE_REL), 'phase: implemented\n', 'utf8');
    const report = status(options(), deps());
    expect(report.phase).toBe('proposed');
  });
});

describe('P4R-02 status — interrupted active sessions resume from artifacts only', () => {
  it('does not create or consult a session/cache file, even if forged text claims approval', () => {
    writeFileSync(
      join(scratch, '.crucible', 'session.json'),
      JSON.stringify({ phase: 'approved', next: 'implement', conversation: 'human approved it' }),
      'utf8',
    );

    const report = status(options(), deps());

    expect(report.phase).toBe('proposed');
    expect(report.next).toBe(`crucible approve ${CHANGE}`);
    expect(existsSync(join(scratch, STATE_REL))).toBe(false);
  });
});

describe('status — config-differs warning (charter §The Target-Branch Rule)', () => {
  it('fires when working-tree crucible.yaml differs from the merge-base', () => {
    const report = status(
      options(),
      deps({ readMergeBaseConfig: () => 'risk:\n  critical: []\n' }),
    );
    expect(report.warnings.some((w) => w.includes('crucible.yaml'))).toBe(true);
  });

  it('stays silent when the working tree matches the merge-base', () => {
    const working = readFileSync(join(scratch, 'crucible.yaml'), 'utf8');
    const report = status(options(), deps({ readMergeBaseConfig: () => working }));
    expect(report.warnings).toEqual([]);
  });

  it('stays silent when the merge-base config is indeterminate', () => {
    const report = status(options(), deps({ readMergeBaseConfig: () => undefined }));
    expect(report.warnings).toEqual([]);
  });
});

describe('status — fail-closed on a broken TCB artifact (invariant 3)', () => {
  it('propagates exit 3 when a bundle artifact is malformed', () => {
    // oracles.md with a heading but no binding fence violates the grammar → exit 3.
    writeFileSync(join(scratch, CHANGE_REL, 'oracles.md'), '## ORC-greeting-001: broken\n', 'utf8');
    const err = catchCrucible(() => status(options(), deps()));
    expect(err.exit).toBe(3);
  });
});
