import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_REVIEW_TEMPLATE_PATH, renderCiTemplateForAdapter } from '@crucible/ci-templates';
import { loadApproval } from '../artifacts/approval.js';
import { ciReviewMode, humanReviewMode, loadEnforcementConfig } from '../config/enforcement.js';
import {
  FRAMEWORK_PIN_RELPATH,
  loadFrameworkPin,
  serializeFrameworkPin,
  type FrameworkPin,
} from '../framework/pin.js';
import { preconditionError } from '../util/errors.js';

export interface FrameworkUpgradeOptions {
  root: string;
  pin: FrameworkPin;
  /** Injected Git edge: callers must reject tracked dirt before this transaction. */
  trackedDirty: boolean;
}

export interface FrameworkUpgradeAction {
  relpath: string;
  kind: 'created' | 'updated' | 'unchanged' | 'removed';
}

export interface FrameworkUpgradeReport {
  actions: FrameworkUpgradeAction[];
}

/**
 * Refresh only framework-owned, tracked consumer bytes. This is intentionally
 * not init: it preserves all enforcement, convenience, product and agent bytes.
 */
export function frameworkUpgrade(options: FrameworkUpgradeOptions): FrameworkUpgradeReport {
  if (options.trackedDirty) {
    throw preconditionError(
      'FRAMEWORK_UPGRADE_DIRTY',
      'Framework upgrade requires a tracked-clean worktree.',
      'Commit, stash, or discard tracked changes before running framework upgrade.',
    );
  }
  const current = loadFrameworkPin(join(options.root, FRAMEWORK_PIN_RELPATH));
  refuseActiveLockSeal(options.root);
  if (current.repository === options.pin.repository && current.commit === options.pin.commit) {
    throw preconditionError(
      'FRAMEWORK_UPGRADE_PIN_UNCHANGED',
      'Framework upgrade requires a new immutable framework pin.',
      'Provide a source pin different from the currently committed pin.',
    );
  }
  const config = loadEnforcementConfig(options.root);
  const adapter = Object.keys(config.adapters)[0];
  if (adapter === undefined) {
    throw preconditionError(
      'FRAMEWORK_UPGRADE_NO_ADAPTER',
      'Framework upgrade requires an initialized enforcement adapter.',
      'Run crucible init before framework upgrade.',
    );
  }

  const desired = new Map<string, string>([
    [FRAMEWORK_PIN_RELPATH, serializeFrameworkPin(options.pin)],
    [
      '.github/workflows/crucible.yml',
      renderCiTemplateForAdapter(adapter, humanReviewMode(config)),
    ],
  ]);
  if (ciReviewMode(config) === 'required') {
    desired.set(
      '.github/workflows/crucible-review.yml',
      readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8'),
    );
  }

  const actions: FrameworkUpgradeAction[] = [];
  for (const [relpath, content] of desired) {
    const path = join(options.root, relpath);
    const currentText = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const kind =
      currentText === undefined ? 'created' : currentText === content ? 'unchanged' : 'updated';
    actions.push({ relpath, kind });
  }
  const reviewPath = join(options.root, '.github/workflows/crucible-review.yml');
  if (ciReviewMode(config) === 'advisory' && existsSync(reviewPath)) {
    actions.push({ relpath: '.github/workflows/crucible-review.yml', kind: 'removed' });
  }

  // Compute every desired action before mutating the worktree. The only writes
  // below are the explicit allowlist established above.
  for (const [relpath, content] of desired) {
    const path = join(options.root, relpath);
    mkdirSync(join(options.root, relpath, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  if (ciReviewMode(config) === 'advisory' && existsSync(reviewPath)) {
    // The only removal in the transaction: the managed optional reviewer workflow.
    // It is intentionally deferred until all writes were prepared.
    rmSync(reviewPath);
  }

  return { actions };
}

function refuseActiveLockSeal(root: string): void {
  const changes = join(root, 'openspec', 'changes');
  if (!existsSync(changes)) return;
  for (const name of readdirSync(changes)) {
    const approvalPath = join(changes, name, 'approval.yaml');
    if (!existsSync(approvalPath)) continue;
    const approval = loadApproval(approvalPath);
    if (Object.hasOwn(approval.files, FRAMEWORK_PIN_RELPATH)) {
      throw preconditionError(
        'FRAMEWORK_UPGRADE_ACTIVE_SEAL',
        'An active approval seals the framework lock and cannot be upgraded in place.',
        'Finish or archive the approved change, then start a fresh change from the new framework pin.',
      );
    }
  }
}
