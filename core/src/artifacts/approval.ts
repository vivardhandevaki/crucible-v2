// approval.yaml — the seal (charter §Approval, Amend, Override — Wire Format;
// design phase-0-1.md §3–4; invariant 6 "Hashes seal").
//
// `crucible approve` writes this committed file: the sha256 of every artifact in
// the review bundle plus every bound test file, with who/when. CI (and local
// `implement`/`verify`) recompute and compare — any mismatch, or any covered
// file gone missing, voids the approval (invariant 3, fail-closed). Post-seal,
// the oracle/TCB paths are immutable; this module is the mechanism that makes an
// edit detectable rather than trusted (invariant 2).
//
// Determinism (invariant 12): `files` keys are emitted in sorted order so the
// serialized bytes depend only on the set of paths + their contents, never on
// the order the caller supplied them or on wall-clock. This module resolves
// *nothing* through an adapter or the substrate — the caller (P1-07 approve /
// P1-12 verify) passes the explicit, ordered list of relative paths to cover.
//
// The `amendments` array is present-but-unused until P2 (`crucible amend`
// appends a delta entry). It must round-trip through serialize→parse unchanged.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError, preconditionError } from '../util/errors.js';
import { hashFile } from '../hash/hash.js';

/** A lowercase sha256 hex digest (64 chars). */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest');

/** `{ <relpath>: sha256 }` — the covered files and their sealed hashes. */
const fileMap = z.record(z.string().min(1), sha256Hex);

/** One P2 amendment: a re-seal at a timestamp over a (sub)set of files. */
const amendmentSchema = z.strictObject({
  at: z.string().min(1),
  files: fileMap,
});

/** approval.yaml (design §3), strict — an unknown key fails closed at exit 3. */
export const approvalSchema = z.strictObject({
  version: z.number().int(),
  change: z.string().min(1),
  approved_by: z.string().min(1),
  approved_at: z.string().min(1),
  files: fileMap,
  amendments: z.array(amendmentSchema),
});

export type Approval = z.infer<typeof approvalSchema>;
export type Amendment = z.infer<typeof amendmentSchema>;

/** The who/when/what metadata a caller supplies; hashes are computed here. */
export interface ApprovalMeta {
  version: number;
  change: string;
  approved_by: string;
  approved_at: string;
}

/** verifyApproval result: valid, or void with every offending relpath named. */
export type VerifyResult = { valid: true } | { valid: false; void: true; mismatches: string[] };

/**
 * Seal a bundle: hash each covered file (relative to `root`) and build the
 * approval object. `files` is emitted sorted for byte-stable serialization
 * regardless of the order `relpaths` arrives in (invariant 12). A missing
 * covered file fails closed at exit 3 (`hashFile`) — you cannot seal what
 * isn't there. Never resolves paths via an adapter (invariant boundary).
 */
export function sealBundle(root: string, relpaths: string[], meta: ApprovalMeta): Approval {
  const files: Record<string, string> = {};
  for (const rel of [...relpaths].sort()) {
    files[rel] = hashFile(join(root, rel));
  }
  return {
    version: meta.version,
    change: meta.change,
    approved_by: meta.approved_by,
    approved_at: meta.approved_at,
    files,
    amendments: [],
  };
}

/**
 * Re-seal an approved bundle with an amendment (charter §Approval, Amend,
 * Override — Wire Format: "a delta entry with new hashes is appended to
 * approval.yaml"; design phase-2.md §3). `crucible amend` calls this after the
 * agent has coherently regenerated the bundle: it recomputes every covered
 * file's hash from current bytes (the same sorted, byte-stable scope `sealBundle`
 * produces), sets that fresh map as the live `files` seal (so `verifyApproval`
 * passes post-amend), and appends `{ at, files }` to `amendments[]` as the audit
 * record of this re-seal. The original approver/approved_at metadata is
 * preserved — an amendment is a delta on an existing approval, not a fresh one.
 */
export function amendApproval(
  root: string,
  relpaths: string[],
  at: string,
  existing: Approval,
): Approval {
  const files: Record<string, string> = {};
  for (const rel of [...relpaths].sort()) {
    files[rel] = hashFile(join(root, rel));
  }
  return {
    ...existing,
    files,
    amendments: [...existing.amendments, { at, files }],
  };
}

/**
 * Recompute every covered file's hash against the seal. Returns `{valid:true}`
 * only if every covered file exists and matches; otherwise `void`, listing —
 * sorted — every relpath whose content differs or that has gone missing
 * (invariant 6). Used by `implement` (precondition) and `verify` (check).
 */
export function verifyApproval(root: string, approval: Approval): VerifyResult {
  const mismatches: string[] = [];
  for (const [rel, sealed] of Object.entries(approval.files)) {
    if (currentHash(join(root, rel)) !== sealed) {
      mismatches.push(rel);
    }
  }
  if (mismatches.length === 0) {
    return { valid: true };
  }
  return { valid: false, void: true, mismatches: mismatches.sort() };
}

/**
 * Current sha256 of a file, or `undefined` if it is missing/unreadable — a
 * void condition here (not an exit-3 throw) so a vanished covered file is
 * reported as a mismatch rather than aborting the whole verify.
 */
function currentHash(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Serialize an approval to canonical approval.yaml text (deterministic). */
export function serializeApproval(approval: Approval): string {
  return stringifyYaml(approval, { sortMapEntries: false });
}

/** Parse + strict-validate approval.yaml text. Any defect → exit 3. */
export function parseApproval(text: string, source: string): Approval {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_APPROVAL',
      `${source}: approval.yaml is not valid YAML — ${messageOf(cause)}`,
      'Do not hand-edit approval.yaml; re-run `crucible approve` to re-seal.',
    );
  }

  const result = approvalSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_APPROVAL',
      `${source}: approval.yaml invalid — ${where}: ${issue.message}`,
      'Do not hand-edit approval.yaml; re-run `crucible approve` to re-seal.',
    );
  }
  return result.data;
}

/** Read approval.yaml from disk and parse it. Missing file → exit 2. */
export function loadApproval(path: string): Approval {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_APPROVAL',
        `No approval.yaml found at ${path}.`,
        'Run `crucible approve` to seal the reviewed bundle before implementing.',
      );
    }
    throw invalidInputError(
      'INVALID_APPROVAL',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on approval.yaml.',
    );
  }
  return parseApproval(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
