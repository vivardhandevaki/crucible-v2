// Project-local framework distribution. A governed repository executes only the
// immutable package copied beneath `.crucible/framework`, never an executable
// discovered on PATH or a consumer-installed OpenSpec runtime.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  FRAMEWORK_PIN_RELPATH,
  parseFrameworkPin,
  serializeFrameworkPin,
  type FrameworkPin,
} from './pin.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

export const FRAMEWORK_PACKAGE_RELPATH = '.crucible/framework';
export const FRAMEWORK_BIN_RELPATH = '.crucible/bin/crucible';
const FRAMEWORK_MANIFEST = 'framework-manifest.json';
const FRAMEWORK_ENTRYPOINT = 'crucible.mjs';
const FRAMEWORK_OPENSPEC = 'openspec.cjs';

interface FrameworkManifest {
  version: 1;
  package: '@crucible/core';
  release: string;
  content_hash: string;
}

export interface PackageFrameworkOptions {
  /** Prepared release root: package.json, built `dist/`, assets, and OpenSpec bundle. */
  source: string;
  /** The deterministic release package directory to replace. */
  output: string;
}

export interface PackageFrameworkReport {
  pin: FrameworkPin;
}

export interface InstallFrameworkOptions {
  root: string;
  /** An already packaged release output, never a git checkout or registry specifier. */
  source: string;
}

export interface InstallFrameworkReport {
  pin: FrameworkPin;
}

/** Inspect a releasable directory without mutating a consumer. */
export function frameworkPinForPackage(source: string): FrameworkPin {
  const manifest = loadFrameworkManifest(source);
  verifyFrameworkDirectory(source, manifest);
  return pinFromManifest(manifest);
}

/**
 * Build a releasable framework directory from built JavaScript. This deliberately
 * refuses TypeScript/source-only inputs so `node` has no hidden TS loader path.
 */
export function packageFrameworkDistribution(
  options: PackageFrameworkOptions,
): PackageFrameworkReport {
  const packageJson = loadCorePackage(options.source);
  const builtEntrypoint = join(options.source, 'dist', 'cli', 'bin.js');
  if (!existsSync(builtEntrypoint)) {
    throw preconditionError(
      'FRAMEWORK_BUILD_OUTPUT_MISSING',
      `Built JavaScript is missing at ${builtEntrypoint}.`,
      'Run `npm run build` before `npm run package`.',
    );
  }
  const openspec = join(options.source, FRAMEWORK_OPENSPEC);
  if (!existsSync(openspec)) {
    throw preconditionError(
      'FRAMEWORK_OPENSPEC_BUNDLE_MISSING',
      `The packaged OpenSpec runtime is missing at ${openspec}.`,
      'Run `npm run package` from a built Crucible release checkout.',
    );
  }

  const staging = mkdtempSync(join(dirname(options.output), '.crucible-framework-package-'));
  try {
    cpSync(builtEntrypoint, join(staging, FRAMEWORK_ENTRYPOINT));
    copyIfPresent(join(options.source, 'assets'), join(staging, 'assets'));
    copyIfPresent(join(options.source, 'adapters'), join(staging, 'adapters'));
    cpSync(openspec, join(staging, FRAMEWORK_OPENSPEC));
    const manifest: FrameworkManifest = {
      version: 1,
      package: '@crucible/core',
      release: packageJson.version,
      content_hash: hashFrameworkDirectory(staging),
    };
    writeFileSync(join(staging, FRAMEWORK_MANIFEST), serializeManifest(manifest), 'utf8');
    replaceDirectory(staging, options.output);
    return { pin: pinFromManifest(manifest) };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Install a release package and its matching immutable lock into a consumer. */
export function installFrameworkDistribution(
  options: InstallFrameworkOptions,
): InstallFrameworkReport {
  const pin = frameworkPinForPackage(options.source);
  const destination = join(options.root, FRAMEWORK_PACKAGE_RELPATH);
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), '.framework-install-'));
  try {
    cpSync(options.source, staging, { recursive: true });
    replaceDirectory(staging, destination);
    writeFileSync(join(options.root, FRAMEWORK_PIN_RELPATH), serializeFrameworkPin(pin), 'utf8');
    const bin = join(options.root, FRAMEWORK_BIN_RELPATH);
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(join(dirname(bin), 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(bin, launcherSource(), 'utf8');
    chmodSync(bin, 0o755);
    return { pin };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Resolve and validate the only executable a governed consumer may use. */
export function resolveFrameworkEntrypoint(root: string): string {
  const pin = loadInstalledFramework(root);
  const packageRoot = join(root, FRAMEWORK_PACKAGE_RELPATH);
  const manifest = loadFrameworkManifest(packageRoot);
  if (
    manifest.package !== pin.package ||
    manifest.release !== pin.release ||
    manifest.content_hash !== pin.content_hash
  ) {
    throw invalidInputError(
      'FRAMEWORK_PIN_MISMATCH',
      `The local framework package does not match ${FRAMEWORK_PIN_RELPATH}.`,
      'Restore the exact packaged framework bytes recorded by the lock.',
    );
  }
  verifyFrameworkDirectory(packageRoot, manifest);
  const entrypoint = join(packageRoot, FRAMEWORK_ENTRYPOINT);
  if (!existsSync(entrypoint)) {
    throw preconditionError(
      'FRAMEWORK_UNREACHABLE',
      `The pinned framework entrypoint is missing at ${entrypoint}.`,
      'Restore the project-local framework distribution recorded by the lock.',
    );
  }
  return entrypoint;
}

export function loadInstalledFramework(root: string): FrameworkPin {
  return parseFrameworkPin(
    readFileSync(join(root, FRAMEWORK_PIN_RELPATH), 'utf8'),
    FRAMEWORK_PIN_RELPATH,
  );
}

function loadCorePackage(source: string): { name: string; version: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  } catch (cause) {
    throw invalidInputError(
      'FRAMEWORK_PACKAGE_INVALID',
      `Could not read framework package metadata: ${String(cause)}.`,
      'Package a built @crucible/core release before installation.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { name?: unknown }).name !== '@crucible/core' ||
    typeof (value as { version?: unknown }).version !== 'string' ||
    !isExactRelease((value as { version: string }).version)
  ) {
    throw invalidInputError(
      'FRAMEWORK_PACKAGE_INVALID',
      'Framework package metadata must identify @crucible/core at an exact released version.',
      'Use a released @crucible/core package; ranges, tags, and source checkouts are not pins.',
    );
  }
  return value as { name: string; version: string };
}

function loadFrameworkManifest(root: string): FrameworkManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, FRAMEWORK_MANIFEST), 'utf8'));
  } catch (cause) {
    throw preconditionError(
      'FRAMEWORK_UNREACHABLE',
      `The local framework manifest is unavailable: ${String(cause)}.`,
      'Restore the project-local framework distribution recorded by the lock.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Partial<FrameworkManifest>).version !== 1 ||
    (value as Partial<FrameworkManifest>).package !== '@crucible/core' ||
    typeof (value as Partial<FrameworkManifest>).release !== 'string' ||
    !isExactRelease((value as FrameworkManifest).release) ||
    !/^[0-9a-f]{64}$/.test((value as Partial<FrameworkManifest>).content_hash ?? '')
  ) {
    throw invalidInputError(
      'FRAMEWORK_MANIFEST_INVALID',
      'The local framework manifest is malformed or mutable.',
      'Restore an exact packaged @crucible/core release.',
    );
  }
  return value as FrameworkManifest;
}

function verifyFrameworkDirectory(root: string, manifest: FrameworkManifest): void {
  const actual = hashFrameworkDirectory(root);
  if (actual !== manifest.content_hash) {
    throw invalidInputError(
      'FRAMEWORK_CONTENT_DRIFT',
      'The project-local framework bytes do not match their immutable content hash.',
      'Restore the exact packaged framework release before running Crucible.',
    );
  }
}

function pinFromManifest(manifest: FrameworkManifest): FrameworkPin {
  return {
    version: 2,
    package: manifest.package,
    release: manifest.release,
    content_hash: manifest.content_hash,
  };
}

function serializeManifest(manifest: FrameworkManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function copyIfPresent(source: string, destination: string): void {
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}

function replaceDirectory(staging: string, destination: string): void {
  const previous = `${destination}.previous`;
  if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, previous);
  try {
    renameSync(staging, destination);
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
  } catch (cause) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, destination);
    throw cause;
  }
}

/** Domain-separated and ordered: same bytes always produce the same package hash. */
function hashFrameworkDirectory(root: string): string {
  const hash = createHash('sha256');
  for (const path of frameworkFiles(root)) {
    hash.update('crucible-framework-v1\0');
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function frameworkFiles(root: string): string[] {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relpath = relative(root, path).replaceAll('\\', '/');
      if (relpath === FRAMEWORK_MANIFEST) continue;
      if (statSync(path).isDirectory()) visit(path);
      else paths.push(relpath);
    }
  };
  visit(root);
  return paths;
}

function isExactRelease(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function launcherSource(): string {
  // Kept self-contained so it can reject a bad package *before* importing it.
  return `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pinPath = join(root, '.crucible', 'framework.lock.json');
const packageRoot = join(root, '.crucible', 'framework');
const fail = (message) => { process.stderr.write('crucible: ' + message + '\\n'); process.exitCode = 3; };
const exact = (value) => /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
try {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'framework-manifest.json'), 'utf8'));
  if (pin.version !== 2 || pin.package !== '@crucible/core' || !exact(pin.release) || !/^[0-9a-f]{64}$/.test(pin.content_hash || '')) throw new Error('framework lock is missing, mutable, or malformed');
  if (manifest.version !== 1 || manifest.package !== pin.package || manifest.release !== pin.release || manifest.content_hash !== pin.content_hash) throw new Error('local framework does not match its lock');
  const files = [];
  const visit = (dir) => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name); const rel = relative(packageRoot, path).replaceAll('\\\\', '/'); if (rel === 'framework-manifest.json') continue; if (statSync(path).isDirectory()) visit(path); else files.push(rel); } };
  visit(packageRoot);
  const hash = createHash('sha256');
  for (const path of files) { hash.update('crucible-framework-v1\\0'); hash.update(path); hash.update('\\0'); hash.update(readFileSync(join(packageRoot, path))); hash.update('\\0'); }
  if (hash.digest('hex') !== pin.content_hash) throw new Error('local framework bytes have drifted');
  const entrypoint = join(packageRoot, '${FRAMEWORK_ENTRYPOINT}');
  if (!existsSync(entrypoint)) throw new Error('pinned framework entrypoint is unreachable');
  const result = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 3;
} catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
`;
}
