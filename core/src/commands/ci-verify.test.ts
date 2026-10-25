import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiTrustPartition } from '../ci/trust.js';
import { isCrucibleError } from '../util/errors.js';
import type { VerifyReport } from '../verifyx/report.js';
import {
  discoverCandidateArchives,
  runCiVerification,
  type CandidateArchive,
  type CiArchiveVerificationContext,
} from './ci-verify.js';

const B = '1'.repeat(40);
const H = '2'.repeat(40);

let scratch: string;
let base: string;
let candidate: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-ci-verify-'));
  base = join(scratch, 'base');
  candidate = join(scratch, 'candidate');
  mkdirSync(base);
  mkdirSync(candidate);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function partition(): CiTrustPartition {
  return {
    version: 1,
    event: 'pull_request',
    repository: 'acme/widget',
    base: {
      repository: 'acme/widget',
      ref: 'refs/heads/main',
      sha: B,
      root: base,
      inputs: [
        'enforcement-config',
        'framework-verifier-pin',
        'adapter-pins-and-bytes',
        'historical-oracles-and-harness',
        'review-policy-and-rubric',
      ],
    },
    candidate: {
      repository: 'contributor/widget',
      sha: H,
      root: candidate,
      inputs: [
        'product-code',
        'ordinary-tests',
        'proposed-approved-change',
        'new-oracle-tests',
        'proposed-trust-edits-as-untrusted-data',
      ],
    },
  };
}

function archive(entry: string, change: string): CandidateArchive {
  const rel = join('openspec', 'changes', 'archive', entry);
  return {
    entry,
    change,
    dir: join(candidate, rel),
    rel,
    sealedRel: join('openspec', 'changes', change),
  };
}

function verifyReport(change: string, verdict: 'pass' | 'fail' = 'pass'): VerifyReport {
  return {
    change,
    verdict,
    checks: [
      {
        name: 'oracles',
        status: verdict,
        findings: verdict === 'pass' ? [] : [{ check: 'oracles', id: 'ORC-x-001', message: 'red' }],
      },
    ],
  };
}

describe('P4R-10B candidate archive discovery', () => {
  it('returns only canonical archive directories newly present in H, sorted', () => {
    const baseArchive = join(base, 'openspec', 'changes', 'archive');
    const candidateArchive = join(candidate, 'openspec', 'changes', 'archive');
    mkdirSync(join(baseArchive, '2026-01-01-existing'), { recursive: true });
    mkdirSync(join(candidateArchive, '2026-01-01-existing'), { recursive: true });
    mkdirSync(join(candidateArchive, '2026-10-25-zeta'), { recursive: true });
    mkdirSync(join(candidateArchive, '2026-10-24-alpha'), { recursive: true });

    expect(discoverCandidateArchives(base, candidate).map((item) => item.entry)).toEqual([
      '2026-10-24-alpha',
      '2026-10-25-zeta',
    ]);
  });

  it.each(['not-dated', '2026-10-25-UPPER', '2026-10-25-../escape'])(
    'rejects a newly introduced non-canonical archive entry %s',
    (entry) => {
      mkdirSync(join(candidate, 'openspec', 'changes', 'archive', entry), { recursive: true });
      expect(() => discoverCandidateArchives(base, candidate)).toThrow();
    },
  );
});

describe('P4R-10B transport orchestration', () => {
  it('passes exact B-owned and H-owned roots to every archive verifier', async () => {
    const item = archive('2026-10-25-add-greeting', 'add-greeting');
    const verifyArchive = vi.fn(
      async (_archive: CandidateArchive, context: CiArchiveVerificationContext) => {
        expect(context).toEqual({
          baseRoot: base,
          candidateRoot: candidate,
          baseSha: B,
          candidateSha: H,
        });
        return verifyReport('add-greeting');
      },
    );

    const report = await runCiVerification(partition(), {
      discoverArchives: () => [item],
      verifyArchive,
    });

    expect(verifyArchive).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      version: 1,
      event: 'pull_request',
      base_sha: B,
      candidate_sha: H,
      verdict: 'pass',
    });
  });

  it('keeps a red verify report red and byte-stable', async () => {
    const item = archive('2026-10-25-add-greeting', 'add-greeting');
    const deps = {
      discoverArchives: () => [item],
      verifyArchive: async () => verifyReport('add-greeting', 'fail'),
    };
    const first = await runCiVerification(partition(), deps);
    const second = await runCiVerification(partition(), deps);
    expect(first.verdict).toBe('fail');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('fails closed when H contains no new pre-PR archived change', async () => {
    await expect(
      runCiVerification(partition(), {
        discoverArchives: () => [],
        verifyArchive: async () => verifyReport('unreachable'),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCrucibleError(error) && error.exit === 3 && error.code === 'CI_CHANGE_MISSING',
    );
  });
});
