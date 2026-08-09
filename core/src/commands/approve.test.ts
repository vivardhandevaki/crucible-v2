import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { loadEnforcementConfig, type EnforcementConfig } from '../config/enforcement.js';
import type { AgentSubstrate, SubstrateRequest, SubstrateResult } from '../substrate/types.js';
import type { DiffFacts } from './verify.js';
import { dependencyOrder } from './bundle.js';
import { approve, type ApproveDeps, type ApproveResult, type WalkAction } from './approve.js';

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

/**
 * Fixed deps: auto-confirm, frozen clock, deterministic approver, plus
 * non-interactive defaults for the P2-14 walk edges — a no-op pager, a walk that
 * always advances (never edits/acks), and edit edges that fail loudly if reached
 * unexpectedly. Interactive tests override the specific edge they exercise.
 */
function deps(overrides: Partial<ApproveDeps> = {}): ApproveDeps {
  return {
    resolve: resolveAllFound,
    confirm: () => Promise.resolve(true),
    now: () => '2026-07-23T00:00:00Z',
    approvedBy: () => 'ada@example.com',
    pager: () => {},
    walk: () => Promise.resolve('next'),
    openEditor: () => Promise.reject(new Error('openEditor not expected in this test')),
    confirmDiff: () => Promise.resolve('accept'),
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

  it('refuses a pre-approval tasks.md', async () => {
    writeFileSync(join(scratch, CHANGE_REL, 'tasks.md'), '# Tasks\n');
    const err = await catchCrucible(() =>
      approve({ root: scratch, change: CHANGE, yes: true }, deps()),
    );
    expect(err.code).toBe('TASKS_PREAPPROVAL');
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

// ── P2-14: the rich review surface (design phase-2.md §8) ─────────────────────

/** The toy repo's own enforcement config (risk globs + tier caps). */
function toyConfig(root: string): EnforcementConfig {
  return loadEnforcementConfig(root);
}

/** Diff facts that compute STANDARD: a spec-delta feature on a non-risk path. */
const standardFacts = (): DiffFacts => ({ touchedPaths: ['src/greeting.ts'], diffLines: 20 });

/** Diff facts that compute CRITICAL: a touched risk-glob path (crucible.yaml). */
const criticalFacts = (): DiffFacts => ({ touchedPaths: ['crucible.yaml'], diffLines: 5 });

/** A pager that records every surface it was asked to display. */
function recordingPager(): { pager: (t: string) => void; shown: string[] } {
  const shown: string[] = [];
  return { pager: (t: string) => void shown.push(t), shown };
}

describe('approve — Stage 1/2 render (design §8)', () => {
  it('renders each oracle scenario side-by-side with its bound test source', async () => {
    const { pager, shown } = recordingPager();
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch), width: 120 },
      deps({ diffFacts: standardFacts, pager }),
    );
    expect(result.approved).toBe(true);
    expect(result.tier).toBe('standard');

    const all = shown.join('\n');
    // The scenario prose (left pane) and the bound-test source (right pane) both appear.
    expect(all).toContain('**Given** a non-empty name');
    expect(all).toContain('returns hello for a name'); // from tests/greeting.test.ts
    // At width ≥ 100 the panes split with a column gutter.
    expect(all).toContain('│');
    // The overview surfaces the proposal's honesty sections prominently.
    expect(all).toContain('Unspecified');
    expect(all).toContain('Seams');
  });

  it('stacks the panes (no gutter) below the side-by-side width threshold', async () => {
    const { pager, shown } = recordingPager();
    await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch), width: 80 },
      deps({ diffFacts: standardFacts, pager }),
    );
    const panels = shown.filter((s) => s.includes('**Given** a non-empty name'));
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.join('\n')).not.toContain('│');
  });
});

describe('approve — --yes fast path is non-critical only (design §8)', () => {
  it('standard tier --yes seals with no acks and no walk', async () => {
    let walked = false;
    const result = await approve(
      { root: scratch, change: CHANGE, yes: true, config: toyConfig(scratch) },
      deps({ diffFacts: standardFacts, walk: () => ((walked = true), Promise.resolve('next')) }),
    );
    expect(result.approved).toBe(true);
    expect(result.tier).toBe('standard');
    expect(walked).toBe(false); // --yes skips the walk entirely
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval.acks).toBeUndefined();
  });

  it('refuses --yes on the critical tier at exit 2', async () => {
    const err = await catchCrucible(() =>
      approve(
        { root: scratch, change: CHANGE, yes: true, config: toyConfig(scratch) },
        deps({ diffFacts: criticalFacts }),
      ),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('CRITICAL_NEEDS_GATE');
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });
});

describe('approve — critical tier per-oracle acks (design §8)', () => {
  it('records an ack per oracle in approval.yaml when all are acknowledged', async () => {
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch) },
      deps({ diffFacts: criticalFacts, walk: () => Promise.resolve('ack') }),
    );
    expect(result.approved).toBe(true);
    expect(result.tier).toBe('critical');
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval.acks?.map((a) => a.oracle)).toEqual(['ORC-greeting-001', 'ORC-greeting-002']);
    for (const ack of approval.acks ?? []) expect(ack.at).toBe('2026-07-23T00:00:00Z');
  });

  it('blocks the seal confirm until every oracle is acked, then seals', async () => {
    // A walk that advances on the initial pass (both oracles) and only acks once
    // the ack gate re-enters — so the gate must loop back before confirm is reached.
    let seq = 0;
    const walk = (): Promise<WalkAction> => {
      seq += 1;
      return Promise.resolve(seq <= 2 ? 'next' : 'ack');
    };

    let confirmCalls = 0;
    const { pager, shown } = recordingPager();
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch) },
      deps({
        diffFacts: criticalFacts,
        walk,
        pager,
        confirm: () => ((confirmCalls += 1), Promise.resolve(true)),
      }),
    );
    expect(result.approved).toBe(true);
    // The re-entry notice was shown (the gate refused to fall through to confirm).
    expect(shown.join('\n')).toContain('still need acknowledgment');
    expect(confirmCalls).toBe(1);
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval.acks).toHaveLength(2);
  });

  it('a quit during the ack gate declines without sealing', async () => {
    // Advance (never ack) on the first pass, then quit when the gate re-enters.
    let seq = 0;
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch) },
      deps({
        diffFacts: criticalFacts,
        walk: () => {
          seq += 1;
          return Promise.resolve(seq <= 2 ? 'next' : 'quit');
        },
      }),
    );
    expect(result.approved).toBe(false);
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });
});

/** A substrate that rewrites the bound test file (a regeneration) and stamps a transcript. */
class RewriteSubstrate implements AgentSubstrate {
  runs = 0;
  constructor(
    private readonly root: string,
    private readonly newTestContent: string,
  ) {}
  run(req: SubstrateRequest): Promise<SubstrateResult> {
    this.runs += 1;
    mkdirSync(dirname(req.transcriptPath), { recursive: true });
    writeFileSync(req.transcriptPath, '{}\n', 'utf8');
    writeFileSync(join(this.root, 'tests', 'greeting.test.ts'), this.newTestContent, 'utf8');
    return Promise.resolve({ exitCode: 0, transcriptPath: req.transcriptPath });
  }
}

describe('approve — inline edit → revalidate → regen-test-diff loop (design §8)', () => {
  it('edits a scenario, regenerates its bound test, shows the diff, and seals', async () => {
    // The editor sharpens ORC-greeting-001's Then clause (a material prose change).
    const oraclesPath = join(scratch, CHANGE_REL, 'oracles.md');
    const openEditor = (): Promise<void> => {
      const text = readFileSync(oraclesPath, 'utf8').replace('`Hello, <name>!`', '`Hi, <name>!`');
      writeFileSync(oraclesPath, text, 'utf8');
      return Promise.resolve();
    };
    // The regeneration rewrites the bound test file to match the sharpened scenario.
    const newTest = readFileSync(join(scratch, 'tests', 'greeting.test.ts'), 'utf8').replace(
      'Hello, Ada!',
      'Hi, Ada!',
    );
    const substrate = new RewriteSubstrate(scratch, newTest);

    // Walk: edit oracle 1 once, then advance; advance oracle 2. (Non-critical.)
    let firstPanel = true;
    const walk = (): Promise<WalkAction> => {
      if (firstPanel) {
        firstPanel = false;
        return Promise.resolve('edit');
      }
      return Promise.resolve('next');
    };

    const { pager, shown } = recordingPager();
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch) },
      deps({
        diffFacts: standardFacts,
        substrate,
        openEditor,
        walk,
        pager,
        confirmDiff: () => Promise.resolve('accept'),
      }),
    );

    expect(result.approved).toBe(true);
    expect(substrate.runs).toBe(1); // the edit triggered exactly one regeneration
    // The regeneration diff was shown, with the changed test lines.
    const all = shown.join('\n');
    expect(all).toContain('regenerated: tests/greeting.test.ts');
    expect(all).toContain('- ');
    expect(all).toContain('+ ');
    // The seal covers the regenerated test file's NEW bytes.
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(readFileSync(join(scratch, 'tests', 'greeting.test.ts'), 'utf8')).toBe(newTest);
    expect(approval.files['tests/greeting.test.ts']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a red revalidation after an edit is not sealable — re-edit or abort', async () => {
    const oraclesPath = join(scratch, CHANGE_REL, 'oracles.md');
    // The editor corrupts the oracle grammar (a malformed id) → revalidation red.
    let corrupted = false;
    const openEditor = (): Promise<void> => {
      if (!corrupted) {
        corrupted = true;
        writeFileSync(oraclesPath, '## ORC-BAD: nope\n\n(no binding)\n', 'utf8');
      }
      return Promise.resolve();
    };
    // Walk: edit (→ red findings), then on the re-prompt quit.
    let calls = 0;
    const walk = (): Promise<WalkAction> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? 'edit' : 'quit');
    };
    const { pager, shown } = recordingPager();
    const result = await approve(
      { root: scratch, change: CHANGE, yes: false, config: toyConfig(scratch) },
      deps({ diffFacts: standardFacts, openEditor, walk, pager }),
    );
    expect(result.approved).toBe(false);
    expect(shown.join('\n')).toContain('red');
    expect(existsSync(approvalPath(scratch))).toBe(false);
  });
});

describe('approve — durable tier floor (P4-17)', () => {
  it('forces a standard pre-implementation diff to critical and seals that floor', async () => {
    const result = await approve(
      {
        root: scratch,
        change: CHANGE,
        yes: false,
        config: toyConfig(scratch),
        forcedTier: 'critical',
      },
      deps({ diffFacts: standardFacts, walk: () => Promise.resolve('ack') }),
    );
    expect(result.tier).toBe('critical');
    const approval = parseApproval(readFileSync(approvalPath(scratch), 'utf8'), 'approval.yaml');
    expect(approval.minimum_tier).toBe('critical');
    expect(approval.acks?.map((ack) => ack.oracle)).toEqual([
      'ORC-greeting-001',
      'ORC-greeting-002',
    ]);
  });

  it('refuses --yes when a critical floor is forced over standard facts', async () => {
    const err = await catchCrucible(() =>
      approve(
        {
          root: scratch,
          change: CHANGE,
          yes: true,
          config: toyConfig(scratch),
          forcedTier: 'critical',
        },
        deps({ diffFacts: standardFacts }),
      ),
    );
    expect(err.code).toBe('CRITICAL_NEEDS_GATE');
  });
});
