// P3-06 acceptance — adapter pins are enforcement inputs. The lockfile parser
// is strict/fail-closed, and its content hash covers the manifest plus the full
// packaged executable so neither invocation law nor verdict code can drift.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCrucibleError } from '../util/errors.js';
import {
  hashAdapterPackage,
  parseAdapterLock,
  serializeAdapterLock,
  type AdapterLock,
} from './lockfile.js';

const HASH = 'a'.repeat(64);
const LOCK: AdapterLock = {
  version: 1,
  adapters: {
    'java-junit': {
      version: '0.0.0',
      manifest: '.crucible/adapters/java-junit.yaml',
      executable: '.crucible/adapters/java-junit.mjs',
      content_hash: HASH,
    },
  },
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-adapter-lock-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('adapter lockfile', () => {
  it('round-trips the strict version + package-path + content-hash schema', () => {
    expect(parseAdapterLock(serializeAdapterLock(LOCK), 'lock')).toEqual(LOCK);
  });

  it.each([
    'version: 1\nadapters: {}\nextra: true\n',
    'version: 1\nadapters:\n  java-junit:\n    version: 0.0.0\n    manifest: m\n    executable: e\n    content_hash: nope\n',
    'version: 2\nadapters: {}\n',
  ])('fails closed on malformed or unknown lockfile data', (text) => {
    expect(() => parseAdapterLock(text, 'lock')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER_LOCK', exit: 3 }),
    );
    try {
      parseAdapterLock(text, 'lock');
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
    }
  });

  it('hashes both manifest and executable bytes in a stable, order-defined digest', () => {
    const manifest = join(scratch, 'manifest.yaml');
    const executable = join(scratch, 'adapter.mjs');
    writeFileSync(manifest, 'name: java-junit\n', 'utf8');
    writeFileSync(executable, '#!/usr/bin/env node\n', 'utf8');
    const first = hashAdapterPackage(manifest, executable);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAdapterPackage(manifest, executable)).toBe(first);

    writeFileSync(manifest, 'name: changed\n', 'utf8');
    expect(hashAdapterPackage(manifest, executable)).not.toBe(first);
    writeFileSync(manifest, 'name: java-junit\n', 'utf8');
    writeFileSync(executable, '#!/usr/bin/env node\n// changed\n', 'utf8');
    expect(hashAdapterPackage(manifest, executable)).not.toBe(first);
  });
});
