// Adapter lockfile — committed version+content-hash pins for installed adapter
// packages (charter §Adapter Lifecycle; P3-06). This is an enforcement boundary:
// strict schema, project-relative canonical paths, lowercase sha256, and a
// length-framed digest covering manifest + full executable bytes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { invalidInputError, preconditionError } from '../util/errors.js';

export const ADAPTER_LOCK_RELPATH = '.crucible/adapters.lock.yaml';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest');
const safeRelpath = z.string().min(1).refine(isSafeRelpath, 'must be a project-relative path');
const pinSchema = z.strictObject({
  version: z.string().min(1),
  manifest: safeRelpath,
  executable: safeRelpath,
  content_hash: sha256Hex,
});
const lockSchema = z.strictObject({
  version: z.literal(1),
  adapters: z.record(z.string().min(1), pinSchema),
});

export type AdapterPin = z.infer<typeof pinSchema>;
export type AdapterLock = z.infer<typeof lockSchema>;

export function parseAdapterLock(text: string, source: string): AdapterLock {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw invalidLock(source, `not valid YAML — ${messageOf(error)}`);
  }
  const parsed = lockSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidLock(source, issues);
  }
  return parsed.data;
}

export function loadAdapterLock(path: string): AdapterLock {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw preconditionError(
        'NO_ADAPTER_LOCK',
        `No adapter lockfile found at ${path}.`,
        'Run `crucible init` or `crucible adapter add <manifest> <executable>`.',
      );
    }
    throw invalidLock(path, `could not be read — ${messageOf(error)}`);
  }
  return parseAdapterLock(text, path);
}

export function serializeAdapterLock(lock: AdapterLock): string {
  const parsed = lockSchema.safeParse(lock);
  if (!parsed.success) throw invalidLock(ADAPTER_LOCK_RELPATH, parsed.error.message);
  const adapters = Object.fromEntries(
    Object.entries(parsed.data.adapters).sort(([left], [right]) => left.localeCompare(right)),
  );
  return stringifyYaml({ version: 1, adapters }, { lineWidth: 0 });
}

/** Canonical package content digest: domain tag + length-framed files in fixed order. */
export function hashAdapterPackage(manifestPath: string, executablePath: string): string {
  let manifest: Buffer;
  let executable: Buffer;
  try {
    manifest = readFileSync(manifestPath);
    executable = readFileSync(executablePath);
  } catch (error) {
    throw invalidInputError(
      'ADAPTER_PACKAGE_UNREADABLE',
      `Could not read adapter package bytes — ${messageOf(error)}`,
      'Restore the packaged manifest and executable, then re-run the adapter command.',
    );
  }
  const hash = createHash('sha256');
  hash.update('crucible-adapter-package-v1\0');
  for (const bytes of [manifest, executable]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function isSafeRelpath(path: string): boolean {
  if (isAbsolute(path) || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function invalidLock(source: string, detail: string) {
  return invalidInputError(
    'INVALID_ADAPTER_LOCK',
    `${source}: invalid adapter lockfile — ${detail}`,
    'Repair the lockfile with `crucible init` or the explicit adapter lifecycle command.',
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
