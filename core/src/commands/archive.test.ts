import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { collectRegressionSuite } from '../regression/regression.js';
import { archive, type ArchiveDeps, type OpenSpecValidation } from './archive.js';

// TCB: archive moves a finished change into the regression set — a corrupt or
// unsealed change entering the suite would judge every future change forever, so
// every precondition fails closed BEFORE the irreversible move (design phase-2.md
// §1). The two OpenSpec edges (validate, archive) are injected so the core stays
// deterministic (invariant 12); the injected archive here really moves the dir,
// so the post-move confirmation + regression registration are exercised end-to-end.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const SEALED = ['proposal.md', 'design.md', 'oracles.md', join('specs', 'greeting', 'spec.md')].map(
  (rel) => join(CHANGE_REL, rel),
);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-archive-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Seal the toy change so its approval is present + valid (unless a file is later edited). */
function approve(root: string): void {
  const approval = sealBundle(root, SEALED, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: '2026-07-24T00:00:00Z',
  });
  writeFileSync(join(root, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}

/** A validate edge that reports OpenSpec-valid. */
const validateOk = (): Promise<OpenSpecValidation> => Promise.resolve({ valid: true, issues: [] });

/** An archive edge that really MOVES the change dir into the archive (as OpenSpec would). */
function movingArchive(root: string, date = '2026-07-25') {
  return (change: string): Promise<void> => {
    const src = join(root, 'openspec', 'changes', change);
    const archiveRoot = join(root, 'openspec', 'changes', 'archive');
    mkdirSync(archiveRoot, { recursive: true });
    renameSync(src, join(archiveRoot, `${date}-${change}`));
    return Promise.resolve();
  };
}

function deps(root: string, overrides: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return {
    now: () => '2026-07-25T12:00:00Z',
    validate: validateOk,
    archive: movingArchive(root),
    ...overrides,
  };
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

describe('archive — happy path (archiving registers bindings)', () => {
  it('moves the approved change into the archive and registers its oracles as regression', async () => {
    approve(scratch);

    const result = await archive({ root: scratch, change: CHANGE }, deps(scratch));

    // The change dir moved; an archive entry exists.
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(false);
    expect(result.archivedRel).toBe(
      join('openspec', 'changes', 'archive', '2026-07-25-add-greeting'),
    );
    expect(existsSync(join(scratch, result.archivedRel, 'oracles.md'))).toBe(true);

    // Acceptance: the archived bindings are now the regression suite.
    const suite = collectRegressionSuite(scratch);
    expect(suite.oracles.map((o) => o.id)).toEqual(['ORC-greeting-001', 'ORC-greeting-002']);
  });

  it('appends an audit event into the MOVED state.yaml (best-effort, never gates)', async () => {
    approve(scratch);
    const result = await archive({ root: scratch, change: CHANGE }, deps(scratch));
    expect(existsSync(join(scratch, result.archivedRel, 'state.yaml'))).toBe(true);
  });
});

describe('archive — preconditions fail closed BEFORE any move', () => {
  it('missing change bundle → exit 2 naming propose', async () => {
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: 'no-such-change' }, deps(scratch)),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('unapproved change → exit 2 naming approve; the change is NOT moved', async () => {
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch)),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('NOT_APPROVED');
    expect(err.hint.toLowerCase()).toContain('approve');
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('a voided seal (a sealed file edited post-approval) → exit 2, not archived', async () => {
    approve(scratch);
    // Edit design.md — it is sealed but carries no Crucible grammar, so it sails
    // past the parser gate and the SEAL check is what catches the drift (exit 2).
    writeFileSync(join(scratch, CHANGE_REL, 'design.md'), '# tampered design\n', 'utf8');
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch)),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('SEAL_VOID');
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('OpenSpec reports invalid → exit 3 (fail-closed on the delta grammar), not archived', async () => {
    approve(scratch);
    const validateBad = (): Promise<OpenSpecValidation> =>
      Promise.resolve({ valid: false, issues: ['missing #### Scenario for REQ-greeting-basic-1'] });
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch, { validate: validateBad })),
    );
    expect(err.exit).toBe(3);
    expect(err.code).toBe('OPENSPEC_INVALID');
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('a malformed bundle artifact → exit 3 (parser gate runs before the seal check)', async () => {
    approve(scratch);
    // The bundle parser (precondition 3) runs before the seal check (precondition
    // 4), so a broken oracles.md fails closed at exit 3 — a corrupt past promise
    // must never enter the regression suite.
    writeFileSync(
      join(scratch, CHANGE_REL, 'oracles.md'),
      '## ORC-greeting-001: no binding fence here\n',
      'utf8',
    );
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch)),
    );
    expect(err.exit).toBe(3);
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('the archiver moving nothing → exit 3 (silence is not success, invariant 3)', async () => {
    approve(scratch);
    const noop = (): Promise<void> => Promise.resolve(); // archiver "returns" but moves nothing
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch, { archive: noop })),
    );
    expect(err.exit).toBe(3);
    expect(err.code).toBe('ARCHIVE_INCOMPLETE');
  });
});
