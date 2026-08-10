import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_REVIEW_TEMPLATE_PATH, renderCiTemplateForAdapter } from '@crucible/ci-templates';
import { ciReviewMode, humanReviewMode, type EnforcementConfig } from '../config/enforcement.js';
import { invalidInputError } from '../util/errors.js';

/** Return deterministic target-branch workflow mismatches for the selected policy. */
export function reviewPostureDrift(root: string, config: EnforcementConfig): string[] {
  const adapter = Object.keys(config.adapters).includes('java-junit')
    ? 'java-junit'
    : (Object.keys(config.adapters)[0] ?? '');
  const expectedMain = renderCiTemplateForAdapter(adapter, humanReviewMode(config));
  const mainPath = join(root, '.github', 'workflows', 'crucible.yml');
  const drift: string[] = [];
  if (!existsSync(mainPath) || readFileSync(mainPath, 'utf8') !== expectedMain)
    drift.push('.github/workflows/crucible.yml');

  const reviewPath = join(root, '.github', 'workflows', 'crucible-review.yml');
  const expectsCiReview = ciReviewMode(config) === 'required';
  const reviewMatches =
    existsSync(reviewPath) &&
    readFileSync(reviewPath, 'utf8') === readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8');
  if ((expectsCiReview && !reviewMatches) || (!expectsCiReview && existsSync(reviewPath)))
    drift.push('.github/workflows/crucible-review.yml');
  return drift;
}

/** Enforcement must not claim green under config/workflow posture disagreement. */
export function assertReviewPostureCongruence(root: string, config: EnforcementConfig): void {
  const drift = reviewPostureDrift(root, config);
  if (drift.length === 0) return;
  throw invalidInputError(
    'REVIEW_POSTURE_DRIFT',
    `Target-branch review policy and managed workflows disagree: ${drift.join(', ')}.`,
    'Run `crucible init` from the pinned framework checkout and confirm the managed workflow diff.',
  );
}
