import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import type { CiAuthorityManifest } from './ci-authority-manifest.js';
import { assertCiVerificationAuthority } from './ci-enforcement.js';

let root: string;
const change = 'add-greeting';
const manifest: CiAuthorityManifest = {
  version: 1,
  lane: 'governed',
  changes: [change],
  base_sha: '1111111111111111111111111111111111111111',
  head_sha: '2222222222222222222222222222222222222222',
  snapshot_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-ci-enforcement-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('CI verification authority — strict precondition', () => {
  it('requires a manifest-named change with a valid approval seal', () => {
    writeApproval();
    expect(() => assertCiVerificationAuthority(root, manifest, change)).not.toThrow();
  });

  it('rejects missing approval or a change absent from the manifest', () => {
    expect(() => assertCiVerificationAuthority(root, manifest, change)).toThrow(/approval/i);
    writeApproval();
    expect(() => assertCiVerificationAuthority(root, manifest, 'other-change')).toThrow(
      /manifest/i,
    );
  });
});

function writeApproval(): void {
  const base = join('openspec', 'changes', change);
  const approval = sealBundle(
    root,
    [
      join(base, 'design.md'),
      join(base, 'oracles.md'),
      join(base, 'proposal.md'),
      join(base, 'specs', 'greeting', 'spec.md'),
    ],
    { version: 1, change, approved_by: 'ada', approved_at: '2026-08-15T00:00:00Z' },
  );
  writeFileSync(join(root, base, 'approval.yaml'), serializeApproval(approval));
}
