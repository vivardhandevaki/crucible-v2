import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { hashFile } from './hash.js';

// TCB: the hash is what seals the gate (invariant 6). It must be a byte-stable,
// deterministic sha256-hex of the raw file bytes (design §4, invariant 12), and
// a vanished covered file must fail closed — never quietly hash to empty
// (invariant 3). Coverage here is deliberately thorough per the test-first rule.

const PROPOSAL = join(VALID_BUNDLE_DIR, 'proposal.md');

const scratch = mkdtempSync(join(tmpdir(), 'crucible-hash-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

describe('hashFile', () => {
  it('returns the lowercase sha256 hex of the raw file bytes', () => {
    const expected = createHash('sha256').update(readFileSync(PROPOSAL)).digest('hex');
    expect(hashFile(PROPOSAL)).toBe(expected);
    expect(hashFile(PROPOSAL)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — identical bytes → identical hash across runs', () => {
    expect(hashFile(PROPOSAL)).toBe(hashFile(PROPOSAL));
  });

  it('is byte-sensitive — a single-byte edit changes the hash', () => {
    const original = join(scratch, 'a.txt');
    const edited = join(scratch, 'b.txt');
    writeFileSync(original, 'hello world\n');
    writeFileSync(edited, 'hello worlD\n');
    expect(hashFile(original)).not.toBe(hashFile(edited));
  });

  it('fails closed at exit 3 for a missing file (never empty)', () => {
    const err = catchCrucible(() => hashFile(join(scratch, 'does-not-exist.txt')));
    expect(err.exit).toBe(3);
  });
});
