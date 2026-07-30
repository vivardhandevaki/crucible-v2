// Live pinned-adapter runtime — the single production seam between command
// shims and the adapter client. P3-06 installs manifest + executable bytes and
// records their digest; P3-08 makes every live command verify that pin before a
// judge is allowed to resolve or run anything.

import { join } from 'node:path';
import { createAdapterClient, type AdapterClient } from './client.js';
import {
  ADAPTER_LOCK_RELPATH,
  hashAdapterPackage,
  loadAdapterLock,
  type AdapterPin,
} from './lockfile.js';
import { loadManifest } from './manifest.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Load the project's one installed adapter, verify its manifest and executable
 * against the committed lock pin, and return a client rooted at `cwd`.
 *
 * Phase 3 deliberately supports one installed adapter per project. The lock
 * schema already permits the future polyglot shape, but silently guessing among
 * multiple judges would be unsafe until runner-aware routing reaches the command
 * dependency contract.
 */
export function loadPinnedAdapterClient(
  root: string,
  cwd: string = root,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): AdapterClient {
  const lock = loadAdapterLock(join(root, ADAPTER_LOCK_RELPATH));
  const entries = Object.entries(lock.adapters);

  if (entries.length === 0) {
    throw preconditionError(
      'NO_ADAPTER_PIN',
      `No adapter is pinned in ${ADAPTER_LOCK_RELPATH}.`,
      'Run `crucible init` or `crucible adapter add <manifest> <executable>`.',
    );
  }
  if (entries.length !== 1) {
    throw invalidInputError(
      'AMBIGUOUS_ADAPTER_PIN',
      `${ADAPTER_LOCK_RELPATH} pins ${entries.length} adapters, but this command cannot safely infer a runner without runner-aware routing.`,
      'Keep one project adapter pinned until polyglot runner routing is installed.',
    );
  }

  const [lockedName, pin] = entries[0]!;
  const manifestPath = join(root, pin.manifest);
  const executablePath = join(root, pin.executable);

  assertPackageHash(lockedName, pin, manifestPath, executablePath);

  const manifest = loadManifest(manifestPath);
  if (manifest.name !== lockedName || manifest.version !== pin.version) {
    throw invalidInputError(
      'ADAPTER_PIN_MISMATCH',
      `Adapter pin ${lockedName}@${pin.version} identifies manifest ${manifest.name}@${manifest.version}.`,
      'Restore the installed adapter package or re-pin it through the explicit adapter lifecycle command.',
    );
  }

  return createAdapterClient({
    manifest,
    cwd,
    // First-party Phase 3 packages are self-contained .mjs executables. Invoke
    // the exact hash-checked bytes with this Node runtime; the manifest still
    // supplies the verb and arguments.
    resolveExecutable: () => ({
      command: process.execPath,
      prefixArgs: [executablePath],
    }),
    timeoutMs,
  });
}

function assertPackageHash(
  name: string,
  pin: AdapterPin,
  manifestPath: string,
  executablePath: string,
): void {
  const actual = hashAdapterPackage(manifestPath, executablePath);
  if (actual === pin.content_hash) return;

  throw invalidInputError(
    'ADAPTER_HASH_MISMATCH',
    `Pinned adapter ${name} has content hash ${actual}, expected ${pin.content_hash}; the judge bytes drifted.`,
    'Restore the committed adapter files or explicitly re-pin the package before re-approving the change.',
  );
}
