import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CI_REVIEW_TEMPLATE_PATH,
  renderAuthorityTransitionTemplateForAdapter,
  renderCiTemplateForAdapter,
} from '@crucible/ci-templates';
import { loadApproval } from '../artifacts/approval.js';
import { parseConvenienceFile } from '../config/convenience.js';
import { loadEnforcementConfig } from '../config/enforcement.js';
import {
  FRAMEWORK_PIN_RELPATH,
  loadFrameworkPin,
  serializeFrameworkPin,
  type FrameworkPin,
} from '../framework/pin.js';
import { preconditionError } from '../util/errors.js';

export const P4_25_LEGACY_BRIDGE_COMMIT = 'f0d49022dd11177b4d745ba97c0331c71f205981';
const P4_25_REPOSITORY = 'vivardhandevaki/crucible-v2';
const MAIN_WORKFLOW = '.github/workflows/crucible.yml';
const REVIEW_WORKFLOW = '.github/workflows/crucible-review.yml';
const ENFORCEMENT_CONFIG = 'crucible.yaml';
const SETTINGS = '.crucible/settings.yaml';

export interface ReviewPostureBootstrapOptions {
  root: string;
  pin: FrameworkPin;
  trackedDirty: boolean;
  acknowledgeRootBootstrap?: boolean;
  writeFile?: (path: string, content: string) => void;
}

export interface ReviewPostureBootstrapAction {
  relpath: string;
  kind: 'updated' | 'removed';
}

export interface ReviewPostureBootstrapReport {
  actions: ReviewPostureBootstrapAction[];
  operatorInstructions: string[];
}

/**
 * The P4-26 manual root transaction. This is not ordinary CI authority: it can
 * run only against the exact post-P4-25 bridge and stages the whole final solo
 * posture atomically for a human-reviewed manual merge.
 */
export function reviewPostureBootstrap(
  options: ReviewPostureBootstrapOptions,
): ReviewPostureBootstrapReport {
  if (options.trackedDirty) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_DIRTY',
      'Review-posture root bootstrap requires a tracked-clean worktree.',
      'Commit, stash, or discard tracked changes before running the bootstrap.',
    );
  }
  if (options.acknowledgeRootBootstrap !== true) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_ACK_REQUIRED',
      'Review-posture root bootstrap requires explicit acknowledgement.',
      'Review the five-file diff and rerun with --acknowledge-root-bootstrap.',
    );
  }

  const lockPath = join(options.root, FRAMEWORK_PIN_RELPATH);
  const currentPin = loadFrameworkPin(lockPath);
  if (
    currentPin.repository !== P4_25_REPOSITORY ||
    currentPin.commit !== P4_25_LEGACY_BRIDGE_COMMIT
  ) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_LEGACY_PIN_MISMATCH',
      'Review-posture root bootstrap requires the exact P4-25 legacy bridge pin.',
      'Start from a fresh checkout of the merged P4-25 legacy bridge.',
    );
  }
  if (
    options.pin.repository !== P4_25_REPOSITORY ||
    options.pin.commit === P4_25_LEGACY_BRIDGE_COMMIT
  ) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_SOURCE_INVALID',
      'Review-posture root bootstrap requires a new immutable Crucible source from the recorded repository.',
      'Provide a reachable new vivardhandevaki/crucible-v2 commit.',
    );
  }

  refuseActiveLockSeal(options.root);
  const configPath = join(options.root, ENFORCEMENT_CONFIG);
  const configText = readRequired(configPath, ENFORCEMENT_CONFIG);
  const config = loadEnforcementConfig(options.root);
  if (config.review !== undefined) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_REVIEW_POLICY_PRESENT',
      'Review-posture root bootstrap requires an absent review policy on the legacy target.',
      'Use an ordinary governed posture change after the legacy root bootstrap is complete.',
    );
  }
  const adapter = Object.keys(config.adapters)[0];
  if (adapter === undefined) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_NO_ADAPTER',
      'Review-posture root bootstrap requires an initialized enforcement adapter.',
      'Repair the initialized target before retrying.',
    );
  }

  const mainPath = join(options.root, MAIN_WORKFLOW);
  const reviewPath = join(options.root, REVIEW_WORKFLOW);
  const expectedBridge = renderAuthorityTransitionTemplateForAdapter(adapter, 'required');
  if (readRequired(mainPath, MAIN_WORKFLOW) !== expectedBridge) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_BRIDGE_MISMATCH',
      'Review-posture root bootstrap requires the exact P4-25 legacy bridge workflow.',
      'Restore the exact merged bridge; do not hand-edit a lookalike workflow.',
    );
  }
  if (readRequired(reviewPath, REVIEW_WORKFLOW) !== readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8')) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_REVIEW_WORKFLOW_MISMATCH',
      'Review-posture root bootstrap requires the exact required-mode detached review workflow.',
      'Restore the target managed reviewer workflow before retrying.',
    );
  }

  const settingsPath = join(options.root, SETTINGS);
  const settingsText = readRequired(settingsPath, SETTINGS);
  const settings = parseConvenienceFile(settingsText, settingsPath, 'settings');
  if (settings.review?.local_mode !== 'advisory') {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_LOCAL_POLICY_PRESENT',
      'Review-posture root bootstrap requires the exact advisory local review policy on the legacy target.',
      'Restore the exact legacy local review policy before retrying.',
    );
  }

  const desired = new Map<string, string>([
    [FRAMEWORK_PIN_RELPATH, serializeFrameworkPin(options.pin)],
    [MAIN_WORKFLOW, renderCiTemplateForAdapter(adapter, 'advisory')],
    [
      ENFORCEMENT_CONFIG,
      appendReviewPolicy(configText, 'ci_mode: advisory\n  human_mode: advisory'),
    ],
    [SETTINGS, replaceLocalReviewPolicy(settingsText)],
  ]);
  const allPaths = [
    FRAMEWORK_PIN_RELPATH,
    MAIN_WORKFLOW,
    REVIEW_WORKFLOW,
    ENFORCEMENT_CONFIG,
    SETTINGS,
  ];
  const originals = new Map<string, string | undefined>();
  for (const relpath of allPaths) {
    const path = join(options.root, relpath);
    originals.set(relpath, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  }

  try {
    for (const [relpath, content] of desired) {
      const path = join(options.root, relpath);
      mkdirSync(join(options.root, relpath, '..'), { recursive: true });
      write(options, path, content);
    }
    rmSync(reviewPath);
  } catch {
    restore(options.root, originals);
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_TRANSACTION_FAILED',
      'Review-posture root bootstrap could not write its complete allowlisted transaction and was rolled back.',
      'Repair the target files and retry from a tracked-clean worktree.',
    );
  }

  return {
    actions: [
      { relpath: FRAMEWORK_PIN_RELPATH, kind: 'updated' },
      { relpath: MAIN_WORKFLOW, kind: 'updated' },
      { relpath: REVIEW_WORKFLOW, kind: 'removed' },
      { relpath: ENFORCEMENT_CONFIG, kind: 'updated' },
      { relpath: SETTINGS, kind: 'updated' },
    ],
    operatorInstructions: [
      'This one root bootstrap is not a Crucible CI authority result.',
      'Remove verify from required checks for this one review-posture root bootstrap PR.',
      'Manually compare the exact five-file diff and source pin before merging.',
      'Confirm fresh local review and deterministic verification, then restore verify immediately after merge.',
    ],
  };
}

function replaceLocalReviewPolicy(text: string): string {
  const legacy = 'review:\n  local_mode: advisory\n';
  if (!text.includes(legacy)) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_LOCAL_POLICY_TEXT_MISMATCH',
      'Review-posture root bootstrap requires exact advisory local review bytes.',
      'Restore the exact legacy settings before retrying.',
    );
  }
  return text.replace(legacy, 'review:\n  local_mode: required\n');
}

function appendReviewPolicy(text: string, body: string): string {
  if (!text.endsWith('\n')) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_TEXT_SHAPE',
      'Review-posture root bootstrap requires newline-terminated legacy configuration bytes.',
      'Restore the exact legacy configuration before retrying.',
    );
  }
  return text + '\nreview:\n  ' + body + '\n';
}

function readRequired(path: string, relpath: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw preconditionError(
      'REVIEW_POSTURE_BOOTSTRAP_PATH_MISSING',
      'Review-posture root bootstrap requires ' + relpath + '.',
      'Restore the exact initialized P4-25 legacy target before retrying.',
    );
  }
  return readFileSync(path, 'utf8');
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
        'REVIEW_POSTURE_BOOTSTRAP_ACTIVE_SEAL',
        'An active approval seals the framework lock and cannot be root-bootstrapped in place.',
        'Finish or archive the approved change, then restart from the advisory target.',
      );
    }
  }
}

function write(options: ReviewPostureBootstrapOptions, path: string, content: string): void {
  if (options.writeFile !== undefined) {
    options.writeFile(path, content);
    return;
  }
  writeFileSync(path, content, 'utf8');
}

function restore(root: string, originals: ReadonlyMap<string, string | undefined>): void {
  for (const [relpath, original] of originals) {
    const path = join(root, relpath);
    if (original === undefined) {
      if (existsSync(path)) rmSync(path, { force: true });
    } else {
      mkdirSync(join(root, relpath, '..'), { recursive: true });
      writeFileSync(path, original, 'utf8');
    }
  }
}
