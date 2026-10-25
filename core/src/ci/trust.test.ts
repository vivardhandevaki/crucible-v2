import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import {
  BASE_OWNED_CI_INPUTS,
  CANDIDATE_OWNED_CI_INPUTS,
  establishCiTrustPartition,
} from './trust.js';

const B = '1'.repeat(40);
const H = '2'.repeat(40);
const MERGE = '3'.repeat(40);

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    event: 'pull_request',
    repository: 'acme/widget',
    base_repository: 'acme/widget',
    base_ref: 'refs/heads/main',
    base_sha: B,
    candidate_repository: 'acme/widget',
    candidate_sha: H,
    event_sha: MERGE,
    observed_target_sha: B,
    base_checkout_sha: B,
    candidate_checkout_sha: H,
    base_root: '/work/base',
    candidate_root: '/work/candidate',
    target_tip_root: '/work/target-tip',
    ...overrides,
  };
}

describe('P4R-10A exact B/H trust boundary', () => {
  it('partitions every base-owned and candidate-owned verification input', () => {
    const partition = establishCiTrustPartition(pullRequest());
    expect(partition).toEqual({
      version: 1,
      event: 'pull_request',
      repository: 'acme/widget',
      base: {
        repository: 'acme/widget',
        ref: 'refs/heads/main',
        sha: B,
        root: '/work/base',
        inputs: BASE_OWNED_CI_INPUTS,
      },
      candidate: {
        repository: 'acme/widget',
        sha: H,
        root: '/work/candidate',
        inputs: CANDIDATE_OWNED_CI_INPUTS,
      },
    });
  });

  it('accepts a fork head only for a restricted pull_request run', () => {
    const partition = establishCiTrustPartition(
      pullRequest({ candidate_repository: 'contributor/widget' }),
    );
    expect(partition.candidate.repository).toBe('contributor/widget');
    expect(partition.base.repository).toBe('acme/widget');
  });

  it('binds merge_group GITHUB_SHA to the target-repository candidate H', () => {
    const partition = establishCiTrustPartition(
      pullRequest({
        event: 'merge_group',
        event_sha: H,
        candidate_repository: 'acme/widget',
      }),
    );
    expect(partition.event).toBe('merge_group');
    expect(partition.candidate.sha).toBe(H);
  });

  it.each([
    ['base checkout substitution', { base_checkout_sha: '4'.repeat(40) }],
    ['candidate checkout substitution', { candidate_checkout_sha: '4'.repeat(40) }],
    ['stale base event', { observed_target_sha: '4'.repeat(40) }],
    ['base repository substitution', { base_repository: 'attacker/widget' }],
    ['malformed base SHA', { base_sha: 'main' }],
    ['malformed candidate SHA', { candidate_sha: 'HEAD' }],
    ['same checkout root', { candidate_root: '/work/base' }],
    ['relative checkout root', { base_root: 'base' }],
    ['unknown event', { event: 'push' }],
    ['unknown input field', { surprise: true }],
  ])('rejects %s before candidate execution', (_name, changed) => {
    expect(() => establishCiTrustPartition(pullRequest(changed))).toThrow();
  });

  it('rejects a fork identity for merge_group', () => {
    expect(() =>
      establishCiTrustPartition(
        pullRequest({
          event: 'merge_group',
          event_sha: H,
          candidate_repository: 'contributor/widget',
        }),
      ),
    ).toThrow();
  });

  it('rejects a merge_group event SHA that is not H', () => {
    expect(() =>
      establishCiTrustPartition(pullRequest({ event: 'merge_group', event_sha: MERGE })),
    ).toThrow();
  });

  it('uses a fail-closed Crucible input error for all rejected evidence', () => {
    try {
      establishCiTrustPartition(pullRequest({ observed_target_sha: '4'.repeat(40) }));
      throw new Error('expected trust-boundary rejection');
    } catch (error) {
      expect(isCrucibleError(error) && error.exit === 3).toBe(true);
    }
  });
});
