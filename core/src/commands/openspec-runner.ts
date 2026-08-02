// Runtime resolution for the exact OpenSpec CLI Crucible ships and tests
// against. Consumer repositories, including JVM projects, must not need their
// own Node package installation merely to create or archive a Crucible change.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { internalError } from '../util/errors.js';

const require = createRequire(import.meta.url);

/** Absolute path to the pinned OpenSpec CLI installed with @crucible/core. */
export function openspecExecutable(): string {
  let moduleEntry: string;
  try {
    moduleEntry = require.resolve('@fission-ai/openspec');
  } catch (cause) {
    throw internalError(
      'OPENSPEC_RUNTIME_UNAVAILABLE',
      `The pinned OpenSpec runtime packaged with Crucible could not be resolved: ${String(cause)}.`,
      'Rebuild or reinstall this Crucible checkout before running propose or archive.',
    );
  }

  // @fission-ai/openspec resolves to dist/index.js; its executable is a stable
  // sibling under the package root. Keep this framework-owned path out of the
  // consumer repo so Java projects need no package.json or network lookup.
  const executable = join(dirname(dirname(moduleEntry)), 'bin', 'openspec.js');
  if (!existsSync(executable)) {
    throw internalError(
      'OPENSPEC_RUNTIME_UNAVAILABLE',
      `The pinned OpenSpec executable is missing at ${executable}.`,
      'Rebuild or reinstall this Crucible checkout before running propose or archive.',
    );
  }
  return executable;
}
