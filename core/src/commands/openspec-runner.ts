// Resolve only the OpenSpec runtime embedded in Crucible's local framework
// package. A consumer's package.json, npx cache, and PATH are never inputs.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preconditionError } from '../util/errors.js';

export function openspecExecutable(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'openspec.cjs'),
    join(moduleDir, '..', '..', 'package', 'openspec.cjs'),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    throw preconditionError(
      'OPENSPEC_RUNTIME_UNAVAILABLE',
      'The OpenSpec runtime packaged with this Crucible release is unavailable.',
      'Restore the exact project-local framework distribution recorded by the lock.',
    );
  }
  return executable;
}
