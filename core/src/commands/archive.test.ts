import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const SEALED = [
  'proposal.md',
  'design.md',
  'oracles.md',
  join('specs', 'greeting', 'spec.md'),
  'evidence.json',
  'risk.md',
  'tests/greeting.test.ts',
].map((rel) => (rel.startsWith('tests/') ? rel : join(CHANGE_REL, rel)));

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-archive-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  installSchemaExtension(scratch);
  writeFileSync(join(scratch, CHANGE_REL, 'evidence.json'), '{"reviewed":true}\n', 'utf8');
  writeFileSync(join(scratch, CHANGE_REL, 'risk.md'), 'Risk accepted by reviewer.\n', 'utf8');
  writeFileSync(join(scratch, CHANGE_REL, 'unknown.bin'), 'opaque\0bytes\n', 'utf8');
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
    resolve: async (targets) =>
      targets.map((target) => ({
        target,
        status: 'found' as const,
        targetFile: 'tests/greeting.test.ts',
      })),
    verify: async () => ({ verdict: 'pass' }),
    syncAndArchive: movingArchive(root),
    ...overrides,
  };
}

/** Install a schema-declared pre-approval extension for P4R archive coverage. */
function installSchemaExtension(root: string): void {
  const schemaDir = join(root, 'openspec', 'schemas', 'crucible');
  mkdirSync(join(schemaDir, 'templates'), { recursive: true });
  writeFileSync(join(schemaDir, 'templates', 'risk.md'), '# Risk\n', 'utf8');
  writeFileSync(join(schemaDir, 'templates', 'evidence.json'), '{}\n', 'utf8');
  writeFileSync(
    join(schemaDir, 'schema.yaml'),
    `name: crucible\nversion: 1\ndescription: test schema\nartifacts:\n  - id: proposal\n    generates: proposal.md\n    description: proposal\n    template: proposal.md\n    requires: []\n  - id: specs\n    generates: 'specs/**/*.md'\n    description: specs\n    template: spec.md\n    requires: [proposal]\n  - id: design\n    generates: design.md\n    description: design\n    template: design.md\n    requires: [specs]\n  - id: evidence\n    generates: evidence.json\n    description: evidence\n    template: evidence.json\n    requires: [design]\n  - id: risk\n    generates: risk.md\n    description: risk\n    template: risk.md\n    requires: [evidence]\n  - id: oracles\n    generates: oracles.md\n    description: oracles\n    template: oracles.md\n    requires: [risk]\n  - id: tasks\n    generates: tasks.md\n    description: tasks\n    template: tasks.md\n    requires: [oracles]\napply:\n  requires: [tasks]\n  tracks: tasks.md\n`,
    'utf8',
  );
  writeFileSync(join(schemaDir, 'templates', 'proposal.md'), '# proposal\n', 'utf8');
  writeFileSync(join(schemaDir, 'templates', 'spec.md'), '# spec\n', 'utf8');
  writeFileSync(join(schemaDir, 'templates', 'design.md'), '# design\n', 'utf8');
  writeFileSync(join(schemaDir, 'templates', 'oracles.md'), '# oracles\n', 'utf8');
  writeFileSync(join(schemaDir, 'templates', 'tasks.md'), '# tasks\n', 'utf8');
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
    let syncCalls = 0;
    const preserved = new Map(
      [
        '.openspec.yaml',
        'proposal.md',
        'design.md',
        'oracles.md',
        'tasks.md',
        'approval.yaml',
        'specs/greeting/spec.md',
        'evidence.json',
        'risk.md',
        'unknown.bin',
      ].map((path) => [path, readFileSync(join(scratch, CHANGE_REL, path))] as const),
    );

    const result = await archive(
      { root: scratch, change: CHANGE },
      deps(scratch, {
        syncAndArchive: async (change) => {
          syncCalls += 1;
          await movingArchive(scratch)(change);
        },
      }),
    );

    // The change dir moved; an archive entry exists.
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(false);
    expect(result.archivedRel).toBe(
      join('openspec', 'changes', 'archive', '2026-07-25-add-greeting'),
    );
    expect(existsSync(join(scratch, result.archivedRel, 'oracles.md'))).toBe(true);

    // P4R-07: this is an opaque, schema-complete move, not a reconstructed
    // bundle. The custom intent artifact and unknown bytes survive untouched.
    expect(readFileSync(join(scratch, result.archivedRel, 'risk.md'), 'utf8')).toBe(
      'Risk accepted by reviewer.\n',
    );
    expect(readFileSync(join(scratch, result.archivedRel, 'evidence.json'), 'utf8')).toBe(
      '{"reviewed":true}\n',
    );
    expect(readFileSync(join(scratch, result.archivedRel, 'unknown.bin'))).toEqual(
      Buffer.from('opaque\0bytes\n'),
    );
    expect(existsSync(join(scratch, result.archivedRel, '.openspec.yaml'))).toBe(true);
    expect(existsSync(join(scratch, result.archivedRel, 'tasks.md'))).toBe(true);
    expect(syncCalls).toBe(1);
    for (const [path, bytes] of preserved) {
      expect(readFileSync(join(scratch, result.archivedRel, path))).toEqual(bytes);
    }
    expect(existsSync(join(scratch, 'tests', 'greeting.test.ts'))).toBe(true);

    // Acceptance: the archived bindings are now the regression suite.
    const suite = collectRegressionSuite(scratch);
    expect(suite.oracles.map((o) => o.id)).toEqual(['ORC-greeting-001', 'ORC-greeting-002']);
  });

  it('does not mutate the moved directory after the byte-preserving archive', async () => {
    approve(scratch);
    const result = await archive({ root: scratch, change: CHANGE }, deps(scratch));
    expect(existsSync(join(scratch, result.archivedRel, 'state.yaml'))).toBe(false);
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

  it('a malformed bundle artifact blocks archive before the seal check', async () => {
    approve(scratch);
    // A broken oracle bundle can never enter the regression suite.
    writeFileSync(
      join(scratch, CHANGE_REL, 'oracles.md'),
      '## ORC-greeting-001: no binding fence here\n',
      'utf8',
    );
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch)),
    );
    expect(err.exit).toBe(2);
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('the archiver moving nothing → exit 3 (silence is not success, invariant 3)', async () => {
    approve(scratch);
    const noop = (): Promise<void> => Promise.resolve(); // archiver "returns" but moves nothing
    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch, { syncAndArchive: noop })),
    );
    expect(err.exit).toBe(3);
    expect(err.code).toBe('ARCHIVE_INCOMPLETE');
  });

  it('refuses an approval that omits a schema-declared pre-approval artifact', async () => {
    const incomplete = sealBundle(
      scratch,
      SEALED.filter((path) => path !== join(CHANGE_REL, 'risk.md')),
      {
        version: 1,
        change: CHANGE,
        approved_by: 'ada@example.com',
        approved_at: '2026-07-24T00:00:00Z',
      },
    );
    writeFileSync(
      join(scratch, CHANGE_REL, 'approval.yaml'),
      serializeApproval(incomplete),
      'utf8',
    );

    const err = await catchCrucible(() =>
      archive({ root: scratch, change: CHANGE }, deps(scratch)),
    );
    expect(err.code).toBe('SCHEMA_ARTIFACT_UNSEALED');
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('requires a freshly green deterministic verification before sync or move', async () => {
    approve(scratch);
    let synced = false;
    const err = await catchCrucible(() =>
      archive(
        { root: scratch, change: CHANGE },
        deps(scratch, {
          verify: async () => ({ verdict: 'fail' }),
          syncAndArchive: async () => {
            synced = true;
          },
        }),
      ),
    );
    expect(err.code).toBe('VERIFY_RED');
    expect(synced).toBe(false);
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('rejects a canonical dated archive collision before syncing', async () => {
    approve(scratch);
    const destination = join(scratch, 'openspec', 'changes', 'archive', '2026-07-25-add-greeting');
    mkdirSync(destination, { recursive: true });
    let synced = false;

    const err = await catchCrucible(() =>
      archive(
        { root: scratch, change: CHANGE },
        deps(scratch, {
          syncAndArchive: async () => {
            synced = true;
          },
        }),
      ),
    );
    expect(err.code).toBe('ARCHIVE_COLLISION');
    expect(synced).toBe(false);
    expect(existsSync(join(scratch, CHANGE_REL))).toBe(true);
  });

  it('rolls back specs and the complete change directory after a partial filesystem failure', async () => {
    approve(scratch);
    const originalProposal = readFileSync(join(scratch, CHANGE_REL, 'proposal.md'), 'utf8');
    const originalSpec = 'old canonical spec\n';
    const canonicalSpec = join(scratch, 'openspec', 'specs', 'greeting', 'spec.md');
    mkdirSync(join(scratch, 'openspec', 'specs', 'greeting'), { recursive: true });
    writeFileSync(canonicalSpec, originalSpec, 'utf8');

    const err = await catchCrucible(() =>
      archive(
        { root: scratch, change: CHANGE },
        deps(scratch, {
          syncAndArchive: async () => {
            writeFileSync(canonicalSpec, 'partially synced\n', 'utf8');
            mkdirSync(join(scratch, 'openspec', 'changes', 'archive'), { recursive: true });
            renameSync(
              join(scratch, CHANGE_REL),
              join(scratch, 'openspec', 'changes', 'archive', '2026-07-25-add-greeting'),
            );
            throw new Error('disk full');
          },
        }),
      ),
    );
    expect(err.code).toBe('ARCHIVE_FAILED');
    expect(readFileSync(join(scratch, CHANGE_REL, 'proposal.md'), 'utf8')).toBe(originalProposal);
    expect(readFileSync(canonicalSpec, 'utf8')).toBe(originalSpec);
    expect(
      existsSync(join(scratch, 'openspec', 'changes', 'archive', '2026-07-25-add-greeting')),
    ).toBe(false);
  });
});
