import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT, VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import {
  type Approval,
  amendApproval,
  parseApproval,
  sealBundle,
  serializeApproval,
  verifyApproval,
} from './approval.js';

// TCB: approval.yaml is the seal (invariant 6). Sealing must be byte-stable
// (invariant 12); any post-seal edit to — or disappearance of — a covered file
// must void the approval and name the offending file (invariant 3). A malformed
// approval.yaml on disk fails closed at exit 3, mirroring loadOracles.

// The P1 hash scope (design §4) as concrete fixture files, relative to the
// bundle root. A bound test file lives outside the bundle dir, so it is passed
// relative to the toy-repo root; sealBundle takes an explicit root + relpaths.
const BUNDLE_ROOT = VALID_BUNDLE_DIR;
const BUNDLE_FILES = ['proposal.md', 'design.md', 'oracles.md', 'specs/greeting/spec.md'];

const META = {
  version: 1,
  change: 'add-greeting',
  approved_by: 'ada@example.com',
  approved_at: '2026-07-22T00:00:00Z',
} as const;

const scratch = mkdtempSync(join(tmpdir(), 'crucible-approval-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Copy the whole toy repo into a fresh temp dir so edits never touch fixtures. */
function copyToyRepo(): string {
  const dest = mkdtempSync(join(tmpdir(), 'crucible-toy-'));
  cpSync(TOY_REPO_ROOT, dest, { recursive: true });
  return join(dest, 'openspec', 'changes', 'add-greeting');
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

describe('sealBundle — determinism (invariant 12)', () => {
  it('produces a valid Approval covering every requested file', () => {
    const approval = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    expect(approval.change).toBe('add-greeting');
    expect(Object.keys(approval.files).sort()).toEqual([...BUNDLE_FILES].sort());
    for (const hash of Object.values(approval.files)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(approval.amendments).toEqual([]);
  });

  it('is byte-stable — sealing twice yields identical hashes and serialized bytes', () => {
    const a = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    const b = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    expect(a.files).toEqual(b.files);
    expect(serializeApproval(a)).toBe(serializeApproval(b));
  });

  it('orders `files` deterministically regardless of input order', () => {
    const forward = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    const reversed = sealBundle(BUNDLE_ROOT, [...BUNDLE_FILES].reverse(), META);
    // Same seal bytes: file ordering does not depend on argument order.
    expect(serializeApproval(forward)).toBe(serializeApproval(reversed));
    expect(Object.keys(forward.files)).toEqual(Object.keys(reversed.files));
  });

  it('includes a bound test file living outside the bundle dir', () => {
    // Seal relative to the toy-repo root so a bound test file is coverable.
    const approval = sealBundle(
      TOY_REPO_ROOT,
      ['openspec/changes/add-greeting/oracles.md', 'tests/greeting.test.ts'],
      META,
    );
    expect(Object.keys(approval.files)).toContain('tests/greeting.test.ts');
  });
});

describe('verifyApproval — void on tamper (invariant 6)', () => {
  it('verifies an untouched sealed bundle as valid', () => {
    const approval = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    expect(verifyApproval(BUNDLE_ROOT, approval)).toEqual({ valid: true });
  });

  it('voids and names the file when a single byte of a covered file changes', () => {
    const bundle = copyToyRepo();
    const approval = sealBundle(bundle, BUNDLE_FILES, META);

    // Flip one byte in a covered file (in the copy, never the fixture).
    const target = join(bundle, 'proposal.md');
    const bytes = readFileSync(target);
    bytes[0] = bytes[0]! ^ 0x01;
    writeFileSync(target, bytes);

    const result = verifyApproval(bundle, approval);
    expect(result).toEqual({ valid: false, void: true, mismatches: ['proposal.md'] });
  });

  it('voids and names a covered file that has gone missing', () => {
    const bundle = copyToyRepo();
    const approval = sealBundle(bundle, BUNDLE_FILES, META);

    rmSync(join(bundle, 'design.md'));

    const result = verifyApproval(bundle, approval);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected void');
    expect(result.void).toBe(true);
    expect(result.mismatches).toEqual(['design.md']);
  });

  it('lists every mismatching file, sorted, when several drift', () => {
    const bundle = copyToyRepo();
    const approval = sealBundle(bundle, BUNDLE_FILES, META);

    writeFileSync(join(bundle, 'proposal.md'), 'tampered\n');
    rmSync(join(bundle, 'oracles.md'));

    const result = verifyApproval(bundle, approval);
    if (result.valid) throw new Error('expected void');
    expect(result.mismatches).toEqual(['oracles.md', 'proposal.md']);
  });
});

describe('amendApproval — re-seal with a delta entry (P2-05, charter wire format)', () => {
  it('appends an amendment, updates the live seal, and preserves original metadata', () => {
    const bundle = copyToyRepo();
    const original = sealBundle(bundle, BUNDLE_FILES, META);

    // The amend agent regenerated a downstream artifact; re-seal the delta.
    writeFileSync(join(bundle, 'design.md'), 'design v2 — regenerated\n');
    const amended = amendApproval(bundle, BUNDLE_FILES, '2026-07-25T02:00:00Z', original);

    // Original approver/approved_at survive — an amendment is a delta, not a re-approval.
    expect(amended.approved_by).toBe(META.approved_by);
    expect(amended.approved_at).toBe(META.approved_at);
    // One amendment recorded, stamped at the injected clock, with the fresh map.
    expect(amended.amendments).toHaveLength(1);
    expect(amended.amendments[0]!.at).toBe('2026-07-25T02:00:00Z');
    expect(amended.amendments[0]!.files).toEqual(amended.files);
    // The live seal reflects the regenerated bytes → design.md hash changed.
    expect(amended.files['design.md']).not.toBe(original.files['design.md']);
    // verifyApproval passes against the amended seal (post-amend hash verification).
    expect(verifyApproval(bundle, amended)).toEqual({ valid: true });
  });

  it('a direct edit after an amendment voids the re-sealed approval', () => {
    const bundle = copyToyRepo();
    const original = sealBundle(bundle, BUNDLE_FILES, META);
    const amended = amendApproval(bundle, BUNDLE_FILES, '2026-07-25T02:00:00Z', original);

    writeFileSync(join(bundle, 'oracles.md'), 'tampered after amend\n');
    const result = verifyApproval(bundle, amended);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.mismatches).toContain('oracles.md');
  });

  it('stacks a second amendment onto the first (append-only history)', () => {
    const bundle = copyToyRepo();
    const original = sealBundle(bundle, BUNDLE_FILES, META);
    const once = amendApproval(bundle, BUNDLE_FILES, '2026-07-25T02:00:00Z', original);
    writeFileSync(join(bundle, 'proposal.md'), 'proposal v2\n');
    const twice = amendApproval(bundle, BUNDLE_FILES, '2026-07-26T02:00:00Z', once);
    expect(twice.amendments).toHaveLength(2);
    expect(twice.amendments.map((a) => a.at)).toEqual([
      '2026-07-25T02:00:00Z',
      '2026-07-26T02:00:00Z',
    ]);
  });
});

describe('approval.yaml serialize/parse round-trip', () => {
  it('round-trips a sealed approval unchanged (deep-equal)', () => {
    const approval = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    expect(parseApproval(serializeApproval(approval), 'approval.yaml')).toEqual(approval);
  });

  it('round-trips a NON-EMPTY amendments array unchanged (P2 forward-compat)', () => {
    const approval: Approval = {
      ...META,
      files: { 'proposal.md': 'a'.repeat(64) },
      amendments: [
        { at: '2026-07-23T00:00:00Z', files: { 'proposal.md': 'b'.repeat(64) } },
        {
          at: '2026-07-24T00:00:00Z',
          files: { 'proposal.md': 'c'.repeat(64), 'design.md': 'd'.repeat(64) },
        },
      ],
    };
    const restored = parseApproval(serializeApproval(approval), 'approval.yaml');
    expect(restored).toEqual(approval);
    expect(restored.amendments).toHaveLength(2);
  });
});

describe('parseApproval — fail closed on malformed input', () => {
  it('rejects invalid YAML at exit 3', () => {
    const err = catchCrucible(() => parseApproval('version: 1\n  bad: : :', 'approval.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects a schema-invalid approval (missing `change`) at exit 3', () => {
    const err = catchCrucible(() =>
      parseApproval('version: 1\napproved_by: x\napproved_at: y\nfiles: {}\n', 'approval.yaml'),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects an unknown top-level key at exit 3 (strict schema)', () => {
    const approval = sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META);
    const withExtra = serializeApproval(approval) + '\nbogus: nope\n';
    const err = catchCrucible(() => parseApproval(withExtra, 'approval.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects a non-hex file hash at exit 3', () => {
    const err = catchCrucible(() =>
      parseApproval(
        [
          'version: 1',
          'change: add-greeting',
          'approved_by: x',
          'approved_at: y',
          'files:',
          '  proposal.md: not-a-hash',
          'amendments: []',
        ].join('\n'),
        'approval.yaml',
      ),
    );
    expect(err.exit).toBe(3);
  });
});

describe('approval.yaml minimum_tier (P4-17)', () => {
  it('round-trips a durable critical floor and preserves it through amend', () => {
    const bundle = copyToyRepo();
    const approval = sealBundle(bundle, BUNDLE_FILES, { ...META, minimum_tier: 'critical' });
    const restored = parseApproval(serializeApproval(approval), 'approval.yaml');
    expect(restored.minimum_tier).toBe('critical');

    const amended = amendApproval(bundle, BUNDLE_FILES, '2026-08-10T00:00:00Z', restored);
    expect(amended.minimum_tier).toBe('critical');
  });

  it.each(['minimum_tier: urgent', 'minimum_tier: CRITICAL', 'minimum_tier: null'])(
    'rejects malformed floor %s at exit 3',
    (minimumTier) => {
      const approval = serializeApproval(sealBundle(BUNDLE_ROOT, BUNDLE_FILES, META));
      const err = catchCrucible(() =>
        parseApproval(`${approval}\n${minimumTier}\n`, 'approval.yaml'),
      );
      expect(err.exit).toBe(3);
    },
  );
});
