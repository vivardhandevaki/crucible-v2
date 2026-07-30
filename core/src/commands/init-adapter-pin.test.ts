// P3-06 acceptance — init's detected adapter package follows the exact same
// install+pin path as `adapter add`, and re-running init is byte-idempotent.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTER_LOCK_RELPATH, loadAdapterLock } from '../adapters/lockfile.js';
import { init, type InitAnswers } from './init.js';

const ANSWERS: InitAnswers = {
  adapter: 'java-junit',
  runners: ['junit'],
  paths: ['**/*.java'],
  unitCommand: 'mvn test',
};

let root: string;
let packageRoot: string;
let manifestPath: string;
let executablePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-init-pin-root-'));
  packageRoot = mkdtempSync(join(tmpdir(), 'crucible-init-pin-package-'));
  manifestPath = join(packageRoot, 'crucible-adapter.yaml');
  executablePath = join(packageRoot, 'java-junit.mjs');
  writeFileSync(
    manifestPath,
    [
      'name: java-junit',
      'version: 0.0.0',
      'runners: [junit]',
      'capabilities: [unit, property, contract, integration]',
      'invocations:',
      "  resolve: 'crucible-adapter-java-junit resolve'",
      "  run: 'crucible-adapter-java-junit run'",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(executablePath, '#!/usr/bin/env node\n', 'utf8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

describe('init — adapter package pin', () => {
  it('installs and pins the detected package, then leaves every byte unchanged on re-run', async () => {
    const options = {
      root,
      answers: ANSWERS,
      adapterPackage: { manifestPath, executablePath },
    };
    await init(options, { confirmOverwrite: () => true });
    const lockBefore = readFileSync(join(root, ADAPTER_LOCK_RELPATH), 'utf8');
    const parsed = loadAdapterLock(join(root, ADAPTER_LOCK_RELPATH));
    expect(parsed.adapters['java-junit']?.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const second = await init(options, {
      confirmOverwrite: () => {
        throw new Error('clean init re-run must not ask to overwrite adapter bytes');
      },
    });
    expect(readFileSync(join(root, ADAPTER_LOCK_RELPATH), 'utf8')).toBe(lockBefore);
    for (const relpath of [
      '.crucible/adapters/java-junit.yaml',
      '.crucible/adapters/java-junit.mjs',
      ADAPTER_LOCK_RELPATH,
    ]) {
      expect(second.actions.find((a) => a.relpath === relpath)?.kind).toBe('unchanged');
    }
  });
});
