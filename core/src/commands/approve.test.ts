import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { parseApproval } from '../artifacts/approval.js';
import {
  readGenerationIfPresent,
  serializeGeneration,
  stampGeneration,
} from '../artifacts/generation.js';
import { dependencyOrder } from './bundle.js';
import { approve, type ApproveDeps, type ApproveResult } from './approve.js';

// TCB: `approve` is the one human gate (charter §The Core Inversion). It must
// refuse to seal an invalid bundle or a red lint (invariant 5 — preconditions
// gate every command), and when it does confirm it must write a correct
// approval.yaml (invariant 6 — hashes seal) and stay deterministic (invariant
// 12): the confirm prompt, the clock, and the resolver are all injected so the
// core never touches wall-clock, randomness, or a real adapter process.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

// The toy repo's two oracle targets → the files they live in (tests.json).
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

/** A resolver that reports every target missing (drives the red-lint path). */
const resolveAllMissing: ResolveFn = (targets) =>
  Promise.resolve(targets.map((target): TargetResolution => ({ target, status: 'missing' })));

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-approve-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Fixed deps: auto-confirm, frozen clock, deterministic approver. */
function deps(overrides: Partial<ApproveDeps> = {}): ApproveDeps {
  return {
    resolve: resolveAllFound,
    confirm: () => Promise.resolve(true),
    now: () => '2026-07-23T00:00:00Z',
    approvedBy: () => 'ada@example.com',
    ...overrides,
  };
}

function approvalPath(root: string): string {
  return join(root, CHANGE_REL, 'approval.yaml');
}

function statePath(root: string): string {
  return join(root, CHANGE_REL, 'state.yaml');
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

describe('approve — preconditions gate the seal (invariant 5)', () => {
  it('refuses a red lint (unresolved binding) at exit 2 with a hint', async () => {
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps({ resolve: resolveAllMissing })),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.length).toBeGreaterThan(0);
    // The refusal names what to run instead (architecture.md §2).
    expect(err.hint).toContain('crucible');
    // No seal is written when the gate refuses.
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('names the exact failing oracle id in the red-lint message', async () => {
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps({ resolve: resolveAllMissing })),
    );
    expect(err.message).toContain('ORC-greeting-001');
  });

  it('refuses a bundle with a missing artifact (no oracles.md) at exit 2', async () => {
    rmSync(join(scratch, CHANGE_REL, 'oracles.md'));
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.exit).toBe(2);
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('fails closed at exit 3 on a malformed oracle grammar (bad id)', async () => {
    // A structurally malformed artifact is fail-closed input, not a precondition.
    writeFileSync(
      join(scratch, CHANGE_REL, 'oracles.md'),
      '## ORC-BAD: nope\n\n```yaml crucible-binding\nrequirement: REQ-x-y-1\nkind: unit\nrunner: stub\ntarget: t\n```\n',
    );
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.exit).toBe(3);
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('refuses a proposal without the required Unspecified/Seams sections (exit 3)', async () => {
    // P1-09 proposal grammar: approve gates on the whole bundle parsing, and a
    // proposal hiding its scope sections is malformed input at this stage.
    writeFileSync(join(scratch, CHANGE_REL, 'proposal.md'), '# Proposal\n\n## Why\n\nBecause.\n');
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Unspecified');
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('refuses a bundle with no proposal.md at exit 2', async () => {
    rmSync(join(scratch, CHANGE_REL, 'proposal.md'));
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.exit).toBe(2);
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('does not write a seal when the human declines the confirm', async () => {
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false },
      deps({ confirm: () => Promise.resolve(false) }),
    );
    expect(result.approved).toBe(false);
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });
});

describe('approve — writes a correct approval.yaml on confirm (invariant 6)', () => {
  it('seals every bundle artifact plus the bound test files', async () => {
    const result = await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    expect(result.approved).toBe(true);

    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval.change).toBe(CHANGE);
    expect(approval.approved_by).toBe('ada@example.com');
    expect(approval.approved_at).toBe('2026-07-23T00:00:00Z');

    const covered = Object.keys(approval.files);
    expect(covered).toContain(join(CHANGE_REL, 'proposal.md'));
    expect(covered).toContain(join(CHANGE_REL, 'design.md'));
    expect(covered).toContain(join(CHANGE_REL, 'oracles.md'));
    expect(covered).toContain(join(CHANGE_REL, 'specs', 'greeting', 'spec.md'));
    // The bound test file (outside the change dir) is inside the seal.
    expect(covered).toContain('tests/greeting.test.ts');
    // Every hash is a lowercase sha256 hex digest.
    for (const hash of Object.values(approval.files)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(approval.amendments).toEqual([]);
  });

  it('honors --yes without invoking the confirm prompt', async () => {
    let confirmCalled = false;
    const result = await approve(
      { root: scratch, change: CHANGE, yes: true },
      deps({
        confirm: () => {
          confirmCalled = true;
          return Promise.resolve(false);
        },
      }),
    );
    expect(confirmCalled).toBe(false);
    expect(result.approved).toBe(true);
    expect(existsSync(approvalPath(scratch))).toBe(true);
  });

  it('a written seal recomputes identically across runs (invariant 12)', async () => {
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    const again = await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    expect(again.approved).toBe(true);
    const approval2 = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval2.files).toEqual(approval.files);
  });
});

describe('approve — idempotence on an unchanged bundle', () => {
  it('re-approve on an unchanged bundle rewrites byte-identical seal content', async () => {
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    const first = readFileSync(approvalPath(scratch), 'utf8');

    const result = await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    const second = readFileSync(approvalPath(scratch), 'utf8');

    expect(result.approved).toBe(true);
    // Same clock + approver + unchanged files → identical seal bytes.
    expect(second).toBe(first);
  });

  it('re-seals with new hashes when a covered file changed between approvals', async () => {
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    const before = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');

    // Edit a covered artifact, then re-approve.
    const proposal = join(scratch, CHANGE_REL, 'proposal.md');
    writeFileSync(proposal, readFileSync(proposal, 'utf8') + '\nappended line\n');
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    const after = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');

    expect(after.files[join(CHANGE_REL, 'proposal.md')]).not.toBe(
      before.files[join(CHANGE_REL, 'proposal.md')],
    );
  });
});

describe('approve — appends a state event (design §3)', () => {
  it('writes state.yaml with an approve event on confirm', async () => {
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    expect(existsSync(statePath(scratch))).toBe(true);
    const state = readFileSync(statePath(scratch), 'utf8');
    expect(state).toContain('approve');
    expect(state).toContain(CHANGE);
    // The frozen clock timestamp appears in the appended event.
    expect(state).toContain('2026-07-23T00:00:00Z');
  });

  it('appends a second event on re-approve rather than clobbering the log', async () => {
    await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    await approve(
      { root: scratch, change: CHANGE, yes: true },
      deps({ now: () => '2026-07-24T00:00:00Z' }),
    );
    const state = readFileSync(statePath(scratch), 'utf8');
    expect(state).toContain('2026-07-23T00:00:00Z');
    expect(state).toContain('2026-07-24T00:00:00Z');
  });

  it('does not append a state event when the human declines', async () => {
    const result: ApproveResult = await approve(
      { root: scratch, change: CHANGE, yes: false },
      deps({ confirm: () => Promise.resolve(false) }),
    );
    expect(result.approved).toBe(false);
    expect(existsSync(statePath(scratch))).toBe(false);
  });
});

describe('approve — staleness gate (charter §Editing Artifacts; P2-05)', () => {
  const changeDir = (root: string): string => join(root, CHANGE_REL);
  const generationPath = (root: string): string => join(changeDir(root), 'generation.yaml');
  const designPath = (root: string): string => join(changeDir(root), 'design.md');

  /** Stamp a coherent generation ledger over the toy bundle (as propose would). */
  function stampToy(root: string): void {
    const gen = stampGeneration(
      changeDir(root),
      CHANGE,
      dependencyOrder(changeDir(root)),
      '2026-07-20T00:00:00Z',
    );
    writeFileSync(generationPath(root), serializeGeneration(gen), 'utf8');
  }

  it('refuses at exit 2 when design.md was edited after oracles was generated', async () => {
    stampToy(scratch);
    // Hand-edit an UPSTREAM artifact after generation → downstream may be stale.
    writeFileSync(designPath(scratch), readFileSync(designPath(scratch), 'utf8') + '\nedited\n');
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('BUNDLE_STALE');
    expect(err.message).toContain('design.md');
    // The teaching hint names both escape hatches.
    expect(err.hint).toContain('--revise');
    expect(err.hint).toContain('--confirm-consistency');
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });

  it('--confirm-consistency proceeds and re-stamps the ledger to current bytes', async () => {
    stampToy(scratch);
    writeFileSync(designPath(scratch), readFileSync(designPath(scratch), 'utf8') + '\nedited\n');
    const result = await approve(
      { root: scratch, change: CHANGE, yes: true, confirmConsistency: true },
      deps(),
    );
    expect(result.approved).toBe(true);
    // The ledger now reflects the edited bytes — a re-check would be clean.
    const gen = readGenerationIfPresent(generationPath(scratch))!;
    const design = gen.artifacts.find((a) => a.path === 'design.md')!;
    // Re-stamped at the frozen approve clock, not the original generation clock.
    expect(gen.generated_at).toBe('2026-07-23T00:00:00Z');
    // And the recorded hash matches the current (edited) design.md.
    const fresh = stampGeneration(changeDir(scratch), CHANGE, ['design.md'], 'x');
    expect(design.hash).toBe(fresh.artifacts[0]!.hash);
  });

  it('a leaf-only edit (oracles.md) is not stale — approve proceeds normally', async () => {
    stampToy(scratch);
    const oracles = join(changeDir(scratch), 'oracles.md');
    writeFileSync(oracles, readFileSync(oracles, 'utf8') + '\n<!-- sharpened -->\n');
    const result = await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    expect(result.approved).toBe(true);
  });

  it('a bundle with no generation ledger passes through (no lineage to check)', async () => {
    // The toy fixture has no generation.yaml; approve seals it as before.
    const result = await approve({ root: scratch, change: CHANGE, yes: true }, deps());
    expect(result.approved).toBe(true);
  });

  it('a declined confirm under staleness re-stamps nothing (no writes)', async () => {
    stampToy(scratch);
    const before = readFileSync(generationPath(scratch), 'utf8');
    writeFileSync(designPath(scratch), readFileSync(designPath(scratch), 'utf8') + '\nedited\n');
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, confirmConsistency: true },
      deps({ confirm: () => Promise.resolve(false) }),
    );
    expect(result.approved).toBe(false);
    expect(existsSync(approvalPath(scratch))).toBe(false);
    // The ledger was NOT re-stamped — the decline wrote nothing.
    expect(readFileSync(generationPath(scratch), 'utf8')).toBe(before);
  });
});
