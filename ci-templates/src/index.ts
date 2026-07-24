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

// src/index.ts (or dist/index.js) → workspace root, where crucible.yml lives.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to the reusable Crucible enforcement workflow. */
export const CI_TEMPLATE_PATH = join(workspaceRoot, CI_TEMPLATE_FILE);
