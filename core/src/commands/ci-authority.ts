import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import type { EnforcementConfig } from '../config/enforcement.js';
import { FRAMEWORK_PIN_RELPATH, loadFrameworkPin } from '../framework/pin.js';
import { invalidInputError, preconditionError } from '../util/errors.js';
import { reviewPostureDrift } from './review-posture.js';
import { renderCiTemplateForAdapter } from '@crucible/ci-templates';
import { humanReviewMode } from '../config/enforcement.js';

const CHANGE_PREFIX = 'openspec/changes/';
const FRAMEWORK_PATHS = new Set([
  FRAMEWORK_PIN_RELPATH,
  '.github/workflows/crucible.yml',
  '.github/workflows/crucible-review.yml',
]);

export type CiAuthorityLane =
  'governed' | 'framework-bootstrap' | 'authority-finalization' | 'archive';

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
  const archives = archivedChanges(paths);
  const changes = activeChanges(paths);

  if (archives.length === 1 && changes.every((change) => change === archives[0]?.change)) {
    const archive = archives[0];
    if (archive === undefined) throw new Error('unreachable archive classification');
    assertArchiveRegistration(options, archive.entry, archive.change, paths);
    return { lane: 'archive', changes: [archive.change] };
  }

  if (changes.length > 0 && archives.length > 0) {
    throw invalidInputError(
      'MIXED_CI_LANES',
      'A pull request mixes an active governed bundle with an archive registration.',
      'Archive the approved change separately from any active governed change.',
    );
  }

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

  if (archives.length > 0) {
    throw invalidInputError(
      'MIXED_CI_LANES',
      'An archive registration must contain exactly one matching active change removal.',
      'Archive one approved change at a time without unrelated archive entries.',
    );
  }

  if (paths.length === 1 && paths[0] === '.github/workflows/crucible.yml') {
    assertAuthorityFinalization(options);
    return { lane: 'authority-finalization', changes: [] };
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
    if (!path.startsWith(CHANGE_PREFIX) || path.startsWith(CHANGE_PREFIX + 'archive/')) continue;
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

interface ArchivedChange {
  entry: string;
  change: string;
}

function archivedChanges(paths: readonly string[]): ArchivedChange[] {
  const found = new Map<string, ArchivedChange>();
  for (const path of paths) {
    const match =
      /^openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*))\//.exec(path);
    if (!match) continue;
    const entry = match[1];
    const change = match[2];
    if (entry === undefined || change === undefined) continue;
    found.set(entry, { entry, change });
  }
  return [...found.values()].sort((a, b) => a.entry.localeCompare(b.entry));
}

function assertArchiveRegistration(
  options: ClassifyCiAuthorityOptions,
  entry: string,
  change: string,
  paths: readonly string[],
): void {
  const activePrefix = CHANGE_PREFIX + change + '/';
  const archivePrefix = CHANGE_PREFIX + 'archive/' + entry + '/';
  if (
    !paths.some((path) => path.startsWith(activePrefix)) ||
    !paths.some((path) => path.startsWith(archivePrefix))
  ) {
    throw invalidInputError(
      'CI_ARCHIVE_INCOMPLETE',
      'An archive registration must remove the active bundle and add its canonical archive entry.',
      'Run the archive command and commit its complete output.',
    );
  }
  if (
    paths.some(
      (path) =>
        !path.startsWith(activePrefix) &&
        !path.startsWith(archivePrefix) &&
        !path.startsWith('openspec/specs/'),
    )
  ) {
    throw invalidInputError(
      'MIXED_CI_LANES',
      'An archive registration contains paths outside its active bundle, archive entry, and merged specs.',
      'Split unrelated changes from the archive registration.',
    );
  }
  const baseApproval = join(options.baseRoot, 'openspec', 'changes', change, 'approval.yaml');
  const archivedDir = join(options.headRoot, 'openspec', 'changes', 'archive', entry);
  if (!existsSync(baseApproval) || !existsSync(archivedDir)) {
    throw preconditionError(
      'CI_ARCHIVE_APPROVAL_REQUIRED',
      'An archive registration requires the base active bundle and its canonical archive entry.',
      'Archive a previously approved change without hand-moving files.',
    );
  }
  const approval = loadApproval(baseApproval);
  if (approval.change !== change || !verifyApproval(options.baseRoot, approval).valid) {
    throw preconditionError(
      'CI_ARCHIVE_APPROVAL_INVALID',
      'The archived change does not have a valid base approval seal.',
      'Restore the approved base bundle and archive it through Crucible.',
    );
  }
}

function assertAuthorityFinalization(options: ClassifyCiAuthorityOptions): void {
  const relpath = '.github/workflows/crucible.yml';
  const basePath = join(options.baseRoot, relpath);
  const headPath = join(options.headRoot, relpath);
  if (!existsSync(basePath) || !existsSync(headPath)) {
    throw preconditionError(
      'CI_FINALIZATION_MISSING_WORKFLOW',
      'Authority finalization requires regular base and candidate managed workflows.',
      'Use the dedicated framework upgrade transition plan.',
    );
  }
  const base = readFileSync(basePath, 'utf8');
  if (!base.includes('pull_request:') || !base.includes('pull_request_target:')) {
    throw invalidInputError(
      'CI_FINALIZATION_LEGACY_MISMATCH',
      'Authority finalization requires the exact dual-trigger transition workflow on the target branch.',
      'Complete the legacy transition phase before finalizing authority.',
    );
  }
  const adapter = Object.keys(options.config.adapters)[0];
  if (adapter === undefined)
    throw preconditionError(
      'CI_FINALIZATION_NO_ADAPTER',
      'Authority finalization requires a configured target adapter.',
      'Repair the initialized target enforcement configuration.',
    );
  const expected = renderCiTemplateForAdapter(adapter, humanReviewMode(options.config));
  if (readFileSync(headPath, 'utf8') !== expected) {
    throw invalidInputError(
      'CI_FINALIZATION_WORKFLOW_MISMATCH',
      'Authority finalization must install the exact pinned final managed workflow.',
      'Run framework upgrade and commit only its final managed workflow output.',
    );
  }
}
