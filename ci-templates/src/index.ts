// CI templates workspace — the reusable Crucible enforcement workflow, shipped as
// data and validated by tests (P1-15).
//
// The workflow file (../crucible.yml) runs `crucible verify` with enforcement
// config read from the *target* branch (charter §The Target-Branch Rule,
// invariant #7). It is YAML data, not code; this module only exposes its name +
// absolute path so the structural test (crucible-template.test.ts) can assert its
// invariant-#7 shape without hard-coding paths.

import { dirname, join } from 'node:path';
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
