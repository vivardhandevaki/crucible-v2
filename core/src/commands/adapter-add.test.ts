// P3-06 acceptance — `crucible adapter add` installs a validated manifest and
// packaged executable into committed project paths and mints the strict
// version+content-hash lock pin. Agent self-report never participates.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTER_LOCK_RELPATH, hashAdapterPackage, loadAdapterLock } from '../adapters/lockfile.js';
import { isCrucibleError } from '../util/errors.js';
import { addAdapter } from './adapter-add.js';

let root: string;
let manifest: string;
let executable: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-adapter-add-'));
  manifest = join(root, 'source-manifest.yaml');
  executable = join(root, 'source-adapter.mjs');
  writeFileSync(
    manifest,
    [
      'name: java-junit',
      'version: 0.0.0',
      'runners: [junit]',
      'capabilities: [unit]',
      'invocations:',
      "  resolve: 'crucible-adapter-java-junit resolve'",
      "  run: 'crucible-adapter-java-junit run'",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(executable, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('addAdapter', () => {
  it('copies the package to canonical paths and writes a matching lock pin', () => {
    const report = addAdapter({ root, manifestPath: manifest, executablePath: executable });
    expect(report.adapter).toBe('java-junit');
    expect(report.actions.map((a) => a.kind)).toEqual(['created', 'created', 'created']);

    const lock = loadAdapterLock(join(root, ADAPTER_LOCK_RELPATH));
    const pin = lock.adapters['java-junit'];
    expect(pin).toEqual(
      expect.objectContaining({
        version: '0.0.0',
        manifest: '.crucible/adapters/java-junit.yaml',
        executable: '.crucible/adapters/java-junit.mjs',
      }),
    );
    expect(pin!.content_hash).toBe(
      hashAdapterPackage(join(root, pin!.manifest), join(root, pin!.executable)),
    );
    expect(readFileSync(join(root, pin!.executable), 'utf8')).toBe(
      readFileSync(executable, 'utf8'),
    );
  });

  it('fails closed before writing anything when the manifest is malformed', () => {
    writeFileSync(manifest, 'name: java-junit\nunknown: true\n', 'utf8');
    expect(() => addAdapter({ root, manifestPath: manifest, executablePath: executable })).toThrow(
      expect.objectContaining({ exit: 3 }),
    );
    expect(existsSync(join(root, '.crucible'))).toBe(false);
  });

  it('refuses to overwrite an existing pin and teaches the explicit upgrade path', () => {
    addAdapter({ root, manifestPath: manifest, executablePath: executable });
    expect(() => addAdapter({ root, manifestPath: manifest, executablePath: executable })).toThrow(
      expect.objectContaining({ code: 'ADAPTER_ALREADY_PINNED', exit: 2 }),
    );
    try {
      addAdapter({ root, manifestPath: manifest, executablePath: executable });
    } catch (error) {
      expect(isCrucibleError(error) && error.hint).toContain('adapter upgrade');
    }
  });
});
