import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import type { EnforcementConfig } from '../config/enforcement.js';
import { FRAMEWORK_PIN_RELPATH, loadFrameworkPin } from '../framework/pin.js';
import { invalidInputError, preconditionError } from '../util/errors.js';
import { reviewPostureDrift } from './review-posture.js';

const CHANGE_PREFIX = 'openspec/changes/';
const FRAMEWORK_PATHS = new Set([
  FRAMEWORK_PIN_RELPATH,
  '.github/workflows/crucible.yml',
  '.github/workflows/crucible-review.yml',
]);

export type CiAuthorityLane = 'governed' | 'framework-bootstrap';

export interface CiAuthority {
  lane: CiAuthorityLane;
  /** Sorted active approved changes. Empty only for a framework bootstrap. */
  changes: string[];
}

export interface ClassifyCiAuthorityOptions {
  /** Checked-out target/base revision. */
  baseRoot: string;
  /** Checked-out candidate/head revision. */
  headRoot: string;
  /** Parsed exclusively from the target/base revision. */
  config: EnforcementConfig;
  /** NUL-safe changed paths computed by the workflow transport boundary. */
  changedPaths: readonly string[];
}

/**
 * Classify all PR files before enforcement. A CI run has authority only for one
 * sealed governed lane or one strictly scoped framework bootstrap; everything
 * else is an invalid input, never a successful no-op.
 */
export function classifyCiAuthority(options: ClassifyCiAuthorityOptions): CiAuthority {
  const paths = canonicalChangedPaths(options.changedPaths);
  const changes = activeChanges(paths);

  if (changes.length > 0) {
    if (paths.some((path) => FRAMEWORK_PATHS.has(path))) {
      throw invalidInputError(
        'MIXED_CI_LANES',
        'A pull request has mixed framework bootstrap files with governed change files.',
        'Split the framework pin/workflow migration from the governed product change.',
      );
    }
    for (const change of changes) assertApprovedBundle(options.headRoot, change);
    return { lane: 'governed', changes };
  }

  if (paths.every((path) => FRAMEWORK_PATHS.has(path)) && paths.includes(FRAMEWORK_PIN_RELPATH)) {
    assertFrameworkBootstrap(options);
    return { lane: 'framework-bootstrap', changes: [] };
  }

  throw invalidInputError(
    'CI_CLASSIFICATION_INVALID',
    'The pull request cannot be classified as a sealed governed change or framework bootstrap.',
    'Commit an approved change bundle, or use the dedicated framework upgrade workflow.',
  );
}

function canonicalChangedPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw invalidInputError(
      'CI_CLASSIFICATION_INVALID',
      'No changed paths were supplied for CI authority classification.',
      'Ensure the workflow passes the NUL-safe base-to-head changed path list.',
    );
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => part === '.' || part === '..' || part.length === 0)
    ) {
      throw invalidInputError(
        'CI_PATH_INVALID',
        'A changed path is not a safe repository-relative POSIX path.',
        'Repair the workflow changed-path transport and retry.',
      );
    }
    if (seen.has(path)) {
      throw invalidInputError(
        'CI_PATH_DUPLICATE',
        'The changed-path transport contains a duplicate path.',
        'Repair the workflow changed-path transport and retry.',
      );
    }
    seen.add(path);
  }
  return [...seen].sort();
}

function activeChanges(paths: readonly string[]): string[] {
  const changes = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(CHANGE_PREFIX)) continue;
    const remainder = path.slice(CHANGE_PREFIX.length);
    const slash = remainder.indexOf('/');
    const change = slash < 1 ? '' : remainder.slice(0, slash);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) {
      throw invalidInputError(
        'CI_CHANGE_PATH_INVALID',
        'A changed OpenSpec path does not name a valid change directory.',
        'Use a valid kebab-case change directory beneath openspec/changes/.',
      );
    }
    changes.add(change);
  }
  return [...changes].sort();
}

function assertApprovedBundle(root: string, change: string): void {
  const changeDir = join(root, 'openspec', 'changes', change);
  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'CI_APPROVAL_REQUIRED',
      'CI can enforce a governed change only after its committed approval seal exists.',
      'Run the approve command for ' + change + ' before opening the pull request.',
    );
  }
  const approval = loadApproval(approvalPath);
  if (approval.change !== change) {
    throw invalidInputError(
      'CI_APPROVAL_CHANGE_MISMATCH',
      'The approval seal does not belong to the changed bundle ' + change + '.',
      'Re-run the amend command to produce a valid seal.',
    );
  }
  const checked = verifyApproval(root, approval);
  if (!checked.valid) {
    throw preconditionError(
      'CI_APPROVAL_INVALID',
      'The committed approval seal for ' + change + ' does not match the candidate artifacts.',
      'Run the amend command and commit the refreshed seal.',
    );
  }
}

function assertFrameworkBootstrap(options: ClassifyCiAuthorityOptions): void {
  const base = loadFrameworkPin(join(options.baseRoot, FRAMEWORK_PIN_RELPATH));
  const head = loadFrameworkPin(join(options.headRoot, FRAMEWORK_PIN_RELPATH));
  if (base.repository === head.repository && base.commit === head.commit) {
    throw invalidInputError(
      'CI_BOOTSTRAP_PIN_UNCHANGED',
      'A framework bootstrap must change the committed framework pin.',
      'Use a governed change for ordinary edits, or select a new immutable framework commit.',
    );
  }
  const drift = reviewPostureDrift(options.headRoot, options.config);
  if (drift.length > 0) {
    throw invalidInputError(
      'CI_BOOTSTRAP_WORKFLOW_DRIFT',
      'A framework bootstrap has incongruent managed workflow files: ' + drift.join(', ') + '.',
      'Run init from the candidate pinned framework checkout and commit its managed workflow output.',
    );
  }
}
