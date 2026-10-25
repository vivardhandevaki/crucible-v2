import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

export const BASE_OWNED_CI_INPUTS = [
  'enforcement-config',
  'framework-verifier-pin',
  'adapter-pins-and-bytes',
  'historical-oracles-and-harness',
  'review-policy-and-rubric',
] as const;

export const CANDIDATE_OWNED_CI_INPUTS = [
  'product-code',
  'ordinary-tests',
  'proposed-approved-change',
  'new-oracle-tests',
  'proposed-trust-edits-as-untrusted-data',
] as const;

export interface CiTrustPartition {
  version: 1;
  event: 'pull_request' | 'merge_group';
  repository: string;
  base: {
    repository: string;
    ref: string;
    sha: string;
    root: string;
    inputs: typeof BASE_OWNED_CI_INPUTS;
  };
  candidate: {
    repository: string;
    sha: string;
    root: string;
    inputs: typeof CANDIDATE_OWNED_CI_INPUTS;
  };
}

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a lowercase forty-hex commit SHA');
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be an exact owner/name repository');
const gitRef = z
  .string()
  .regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/, 'must be a full refs/heads/* ref')
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.lock'),
    'contains an unsafe git ref segment',
  );
const absoluteRoot = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && normalize(value) === value, {
    message: 'must be a normalized absolute path',
  });

const evidenceSchema = z.strictObject({
  version: z.literal(1),
  event: z.enum(['pull_request', 'merge_group']),
  repository,
  base_repository: repository,
  base_ref: gitRef,
  base_sha: sha,
  candidate_repository: repository,
  candidate_sha: sha,
  event_sha: sha,
  observed_target_sha: sha,
  base_checkout_sha: sha,
  candidate_checkout_sha: sha,
  base_root: absoluteRoot,
  candidate_root: absoluteRoot,
  target_tip_root: absoluteRoot,
});

export type CiTrustEvidence = z.infer<typeof evidenceSchema>;

/**
 * Validate GitHub event identities and the three independently observed
 * checkouts before candidate code or candidate-controlled executable input is
 * allowed to run. Branch names never stand in for commit identities here.
 */
export function establishCiTrustPartition(input: unknown): CiTrustPartition {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      'CI_TRUST_EVIDENCE_INVALID',
      `CI trust evidence is malformed at ${issue?.path.join('.') || '(root)'}: ${issue?.message || 'invalid input'}.`,
    );
  }
  const evidence = parsed.data;

  if (evidence.base_repository !== evidence.repository) {
    fail(
      'CI_BASE_REPOSITORY_MISMATCH',
      `Event target ${evidence.repository} does not match base repository ${evidence.base_repository}.`,
    );
  }
  if (evidence.base_sha === evidence.candidate_sha) {
    fail('CI_COMMIT_IDENTITY_COLLISION', 'Base commit B and candidate commit H are identical.');
  }
  if (evidence.base_checkout_sha !== evidence.base_sha) {
    fail(
      'CI_BASE_CHECKOUT_MISMATCH',
      `Base checkout resolved to ${evidence.base_checkout_sha}, expected exact B ${evidence.base_sha}.`,
    );
  }
  if (evidence.candidate_checkout_sha !== evidence.candidate_sha) {
    fail(
      'CI_CANDIDATE_CHECKOUT_MISMATCH',
      `Candidate checkout resolved to ${evidence.candidate_checkout_sha}, expected exact H ${evidence.candidate_sha}.`,
    );
  }
  if (evidence.observed_target_sha !== evidence.base_sha) {
    fail(
      'CI_STALE_BASE_EVENT',
      `Target branch now resolves to ${evidence.observed_target_sha}, not event base B ${evidence.base_sha}.`,
    );
  }

  const roots = [evidence.base_root, evidence.candidate_root, evidence.target_tip_root].map(
    (path) => resolve(path),
  );
  if (new Set(roots).size !== roots.length) {
    fail(
      'CI_CHECKOUT_ROOT_COLLISION',
      'Base, candidate, and target-tip checkouts must use three distinct absolute roots.',
    );
  }

  if (evidence.event === 'merge_group') {
    if (evidence.candidate_repository !== evidence.repository) {
      fail(
        'CI_MERGE_GROUP_REPOSITORY_MISMATCH',
        'A merge-group candidate must be an exact commit in the target repository.',
      );
    }
    if (evidence.event_sha !== evidence.candidate_sha) {
      fail(
        'CI_MERGE_GROUP_SHA_MISMATCH',
        `merge_group GITHUB_SHA ${evidence.event_sha} does not equal candidate H ${evidence.candidate_sha}.`,
      );
    }
  }

  return {
    version: 1,
    event: evidence.event,
    repository: evidence.repository,
    base: {
      repository: evidence.base_repository,
      ref: evidence.base_ref,
      sha: evidence.base_sha,
      root: evidence.base_root,
      inputs: BASE_OWNED_CI_INPUTS,
    },
    candidate: {
      repository: evidence.candidate_repository,
      sha: evidence.candidate_sha,
      root: evidence.candidate_root,
      inputs: CANDIDATE_OWNED_CI_INPUTS,
    },
  };
}

function fail(code: string, message: string): never {
  throw invalidInputError(
    code,
    message,
    'Re-run the trusted workflow from a fresh GitHub event; never substitute a branch name or unchecked path for B or H.',
  );
}
