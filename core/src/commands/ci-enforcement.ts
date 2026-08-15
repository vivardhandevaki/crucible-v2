import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import type { CiAuthorityManifest } from './ci-authority-manifest.js';
import { preconditionError } from '../util/errors.js';

/** CI-only gate before any resolver, test runner, or candidate code can execute. */
export function assertCiVerificationAuthority(
  root: string,
  manifest: CiAuthorityManifest,
  change: string,
): void {
  if (manifest.lane !== 'governed' || !manifest.changes.includes(change)) {
    throw preconditionError(
      'CI_MANIFEST_CHANGE_UNAUTHORIZED',
      'The CI authority manifest does not authorize verification of this change.',
      'Re-run the target-owned authority job and use its exact manifest.',
    );
  }
  const approvalPath = join(root, 'openspec', 'changes', change, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'CI_APPROVAL_REQUIRED',
      'CI verification requires a committed approval seal.',
      'Run the approval command before opening the pull request.',
    );
  }
  const checked = verifyApproval(root, loadApproval(approvalPath));
  if (!checked.valid) {
    throw preconditionError(
      'CI_APPROVAL_INVALID',
      'The candidate approval seal is void before CI execution.',
      'Run the amend command, reseal the bundle, and commit the refreshed approval.',
    );
  }
}
