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
  /** Test seam for a mid-transaction filesystem failure. */
  writeFile?: (path: string, content: string) => void;
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

  // Snapshot every allowlisted byte before mutation. If any write/removal fails,
  // restore the complete pre-transaction state rather than leaving a new pin with
  // an old workflow (or vice versa).
  const originals = new Map<string, string | undefined>();
  for (const relpath of new Set([...desired.keys(), '.github/workflows/crucible-review.yml'])) {
    const path = join(options.root, relpath);
    originals.set(relpath, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  }
  try {
    for (const [relpath, content] of desired) {
      const path = join(options.root, relpath);
      mkdirSync(join(options.root, relpath, '..'), { recursive: true });
      writeUpgradeFile(options, path, content);
    }
    if (ciReviewMode(config) === 'advisory' && existsSync(reviewPath)) rmSync(reviewPath);
  } catch {
    for (const [relpath, original] of originals) {
      const path = join(options.root, relpath);
      if (original === undefined) {
        if (existsSync(path)) rmSync(path, { force: true });
      } else {
        mkdirSync(join(options.root, relpath, '..'), { recursive: true });
        writeFileSync(path, original, 'utf8');
      }
    }
    throw preconditionError(
      'FRAMEWORK_UPGRADE_TRANSACTION_FAILED',
      'Framework upgrade could not write its complete allowlisted transaction and was rolled back.',
      'Repair the managed workflow path and retry from a tracked-clean worktree.',
    );
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

function writeUpgradeFile(options: FrameworkUpgradeOptions, path: string, content: string): void {
  if (options.writeFile) {
    options.writeFile(path, content);
    return;
  }
  writeFileSync(path, content, 'utf8');
}
