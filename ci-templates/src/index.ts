// CI templates workspace — the reusable Crucible enforcement workflow, shipped as
// data and validated by tests (P1-15).
//
// The workflow file (../crucible.yml) runs `crucible verify` with enforcement
// config read from the *target* branch (charter §The Target-Branch Rule,
// invariant #7). It is YAML data, not code; this module only exposes its name +
// absolute path so the structural test (crucible-template.test.ts) can assert its
// invariant-#7 shape without hard-coding paths.

import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Filename of the reusable Crucible CI workflow shipped from this workspace. */
export const CI_TEMPLATE_FILE = 'crucible.yml';

/** JVM variant: the same enforcement gate plus JDK and Docker readiness. */
export const JAVA_JUNIT_CI_TEMPLATE_FILE = 'crucible-java-junit.yml';

/** Target-branch-owned detached reviewer workflow (P4-14). */
export const CI_REVIEW_TEMPLATE_FILE = 'crucible-review.yml';

// src/index.ts (or dist/index.js) → workspace root, where crucible.yml lives.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to the reusable Crucible enforcement workflow. */
export const CI_TEMPLATE_PATH = join(workspaceRoot, CI_TEMPLATE_FILE);

/** Absolute path to the JVM/Testcontainers-ready enforcement workflow. */
export const JAVA_JUNIT_CI_TEMPLATE_PATH = join(workspaceRoot, JAVA_JUNIT_CI_TEMPLATE_FILE);

/** Absolute path to the credential-isolated reviewer workflow. */
export const CI_REVIEW_TEMPLATE_PATH = join(workspaceRoot, CI_REVIEW_TEMPLATE_FILE);

/** Select the shipped workflow from the enforcement adapter, never convenience config. */
export function ciTemplatePathForAdapter(adapter: string): string {
  return adapter === 'java-junit' ? JAVA_JUNIT_CI_TEMPLATE_PATH : CI_TEMPLATE_PATH;
}

/**
 * Render the target-branch route policy into the managed enforcement workflow.
 * Required mode is byte-identical to the shipped asset. Advisory mode removes
 * the job entirely: it never synthesizes a passing or skipped route check.
 */
export function renderCiTemplateForAdapter(
  adapter: string,
  humanReviewMode: 'advisory' | 'required',
): string {
  const source = readFileSync(ciTemplatePathForAdapter(adapter), 'utf8');
  if (humanReviewMode === 'required') return source;

  const withoutReviewTrigger = source.replace(
    /\n {2}# Re-run when a review is submitted\/dismissed so `route` re-checks approval and\n {2}# the required check flips green the moment a non-author approves\.\n {2}pull_request_review:\n/,
    '\n',
  );
  // P4-24 deliberately replaced the old route-job prose with a
  // credential-separation comment. The YAML key is the stable managed boundary.
  const routeStart = withoutReviewTrigger.indexOf('\n  route:');
  if (routeStart < 0) {
    throw new Error('Shipped Crucible workflow is missing its required route job.');
  }
  const authorityStart = withoutReviewTrigger.indexOf('\n  authority:', routeStart);
  if (authorityStart < 0) {
    throw new Error('Shipped Crucible workflow is missing its required authority job.');
  }
  return (
    withoutReviewTrigger.slice(0, routeStart).replace(/\s*$/, '\n') +
    withoutReviewTrigger.slice(authorityStart)
  );
}

/** Render the one-time P4-25 bridge for a legacy pull_request-only target.
 * The pull_request half is deliberately non-authoritative: the target cannot
 * yet execute P4-25 authority. Target-owned authority starts only after this
 * exact bridge is merged and finalization is judged by pull_request_target. */
export function renderAuthorityTransitionTemplateForAdapter(
  adapter: string,
  humanReviewMode: 'advisory' | 'required',
): string {
  const finalWorkflow = renderCiTemplateForAdapter(adapter, humanReviewMode);
  const n = String.fromCharCode(10);
  const marker = 'on:' + n + '  pull_request_target:';
  if (!finalWorkflow.includes(marker))
    throw new Error('Final managed workflow lacks pull_request_target.');
  const targetEvent = "${{ github.event_name != 'pull_request' }}";
  const legacyEvent = "${{ github.event_name == 'pull_request' }}";
  let bridge = finalWorkflow.replace(
    marker,
    'on:' + n + '  pull_request:' + n + '  pull_request_target:',
  );
  for (const job of ['authority', 'verify', 'route']) {
    const jobMarker = n + '  ' + job + ':' + n;
    if (!bridge.includes(jobMarker))
      throw new Error('Final managed workflow is missing required job: ' + job + '.');
    bridge = bridge.replace(jobMarker, n + '  ' + job + ':' + n + '    if: ' + targetEvent + n);
  }
  return (
    bridge +
    n +
    '  legacy-bootstrap:' +
    n +
    '    if: ' +
    legacyEvent +
    n +
    '    runs-on: ubuntu-latest' +
    n +
    '    permissions:' +
    n +
    '      contents: read' +
    n +
    '    steps:' +
    n +
    '      - name: Manual legacy bootstrap acknowledgement' +
    n +
    '        run: |' +
    n +
    '          set -euo pipefail' +
    n +
    '          echo Legacy bootstrap requires manual bootstrap acknowledgement.' +
    n +
    '          echo This candidate-owned job is not a Crucible enforcement gate.' +
    n
  );
}
