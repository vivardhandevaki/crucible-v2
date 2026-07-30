// `crucible adapter add` deterministic core (charter §Adapter Lifecycle). A
// validated package is copied to canonical committed paths and then pinned by
// version + combined content hash. Existing pins are never overwritten through
// add; that security-relevant transition belongs to explicit `adapter upgrade`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  ADAPTER_LOCK_RELPATH,
  hashAdapterPackage,
  loadAdapterLock,
  serializeAdapterLock,
  type AdapterLock,
} from '../adapters/lockfile.js';
import { loadManifest } from '../adapters/manifest.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

export interface AddAdapterOptions {
  root: string;
  manifestPath: string;
  executablePath: string;
}

export interface AdapterAddAction {
  relpath: string;
  kind: 'created';
}

export interface AdapterAddReport {
  adapter: string;
  actions: AdapterAddAction[];
}

export function addAdapter(options: AddAdapterOptions): AdapterAddReport {
  const manifest = loadManifest(options.manifestPath);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    throw invalidInputError(
      'INVALID_ADAPTER_NAME',
      `Adapter name ${JSON.stringify(manifest.name)} is not safe for an install path.`,
      'Use lowercase letters, digits, and hyphens in the manifest name.',
    );
  }

  let manifestBytes: Buffer;
  let executableBytes: Buffer;
  try {
    manifestBytes = readFileSync(options.manifestPath);
    executableBytes = readFileSync(options.executablePath);
  } catch (error) {
    throw invalidInputError(
      'ADAPTER_PACKAGE_UNREADABLE',
      `Could not read adapter package — ${messageOf(error)}`,
      'Pass readable manifest and packaged-executable paths.',
    );
  }

  const lockPath = join(options.root, ADAPTER_LOCK_RELPATH);
  const lock: AdapterLock = existsSync(lockPath)
    ? loadAdapterLock(lockPath)
    : { version: 1, adapters: {} };
  if (lock.adapters[manifest.name] !== undefined) {
    throw preconditionError(
      'ADAPTER_ALREADY_PINNED',
      `Adapter ${manifest.name} is already pinned in ${ADAPTER_LOCK_RELPATH}.`,
      `Run \`crucible adapter upgrade ${manifest.name}\` to replace and re-hash it.`,
    );
  }

  const manifestRel = `.crucible/adapters/${manifest.name}.yaml`;
  const executableRel = `.crucible/adapters/${manifest.name}.mjs`;
  for (const relpath of [manifestRel, executableRel]) {
    if (existsSync(join(options.root, relpath))) {
      throw preconditionError(
        'ADAPTER_INSTALL_CONFLICT',
        `${relpath} exists without a matching lock pin.`,
        'Repair the partial install, then re-run `crucible adapter add`.',
      );
    }
  }

  mkdirSync(join(options.root, '.crucible', 'adapters'), { recursive: true });
  writeFileSync(join(options.root, manifestRel), manifestBytes);
  writeFileSync(join(options.root, executableRel), executableBytes, { mode: 0o755 });
  chmodSync(join(options.root, executableRel), 0o755);

  lock.adapters[manifest.name] = {
    version: manifest.version,
    manifest: manifestRel,
    executable: executableRel,
    content_hash: hashAdapterPackage(
      join(options.root, manifestRel),
      join(options.root, executableRel),
    ),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, serializeAdapterLock(lock), 'utf8');

  return {
    adapter: manifest.name,
    actions: [manifestRel, executableRel, ADAPTER_LOCK_RELPATH].map((relpath) => ({
      relpath,
      kind: 'created' as const,
    })),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
