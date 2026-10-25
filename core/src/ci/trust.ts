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

/** P4R-10A red-test seam. The next commit implements the ratified contract. */
export function establishCiTrustPartition(_input: unknown): CiTrustPartition {
  throw invalidInputError(
    'CI_TRUST_BOUNDARY_UNIMPLEMENTED',
    'The exact B/H CI trust boundary is ratified but not implemented.',
    'Implement P4R-10A before adding any CI transport.',
  );
}
