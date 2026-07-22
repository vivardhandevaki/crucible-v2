// Canonical file hashing — the primitive that seals the gate (charter §Approval,
// Amend, Override; design phase-0-1.md §4; invariant 6 "Hashes seal").
//
// Canonical form is the simplest thing that can be tamper-evident: the raw file
// bytes, sha256, lowercase hex. No normalization, no encoding assumptions — a
// single flipped byte must change the digest, which is what lets approval.yaml
// detect any post-seal edit. This is deterministic (invariant 12): same bytes →
// same hash, no wall-clock or randomness. A covered file that has vanished is a
// void condition, not an empty hash, so a missing file fails closed at exit 3
// (invariant 3) — callers that need to *tolerate* absence (verifyApproval) catch
// this and record it as a mismatch rather than swallowing it here.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { invalidInputError } from '../util/errors.js';

/** Lowercase sha256 hex of a file's raw bytes. Missing/unreadable → exit 3. */
export function hashFile(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw invalidInputError(
      'HASH_UNREADABLE',
      `${path}: could not be read to hash — ${messageOf(cause)}`,
      'A covered file is missing or unreadable; re-run `crucible approve` to re-seal.',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
