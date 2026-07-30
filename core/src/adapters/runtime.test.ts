import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_LOCK_RELPATH, hashAdapterPackage, serializeAdapterLock } from './lockfile.js';
import { isCrucibleError } from '../util/errors.js';
import { loadPinnedAdapterClient } from './runtime.js';

// P3-08 turns the P3-06 lockfile into the live adapter edge used by every CLI
// command. The executable that runs must be the package whose manifest + bytes
// match the committed pin; drift is an enforcement failure, not a doctor-only
// warning (charter: the binary running in CI must hash-match the pin).

let root: string;
let packageRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-adapter-runtime-root-'));
  packageRoot = mkdtempSync(join(tmpdir(), 'crucible-adapter-runtime-package-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

function installAdapter(): void {
  const manifest = join(packageRoot, 'crucible-adapter.yaml');
  const executable = join(packageRoot, 'java-junit.mjs');
  writeFileSync(
    manifest,
    [
      'name: java-junit',
      'version: 1.2.3',
      'runners: [junit]',
      'capabilities: [unit]',
      'invocations:',
      "  resolve: 'crucible-adapter-java-junit resolve'",
      "  run: 'crucible-adapter-java-junit run'",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => (input += chunk));",
      "process.stdin.on('end', () => {",
      '  const { targets } = JSON.parse(input);',
      '  const verb = process.argv[2];',
      '  const results = targets.map((target) =>',
      "    verb === 'resolve'",
      "      ? { target, status: 'found', targetFile: 'src/test/java/HelloTest.java' }",
      "      : { target, status: 'pass' },",
      '  );',
      '  process.stdout.write(JSON.stringify({ results }));',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  const adaptersDir = join(root, '.crucible', 'adapters');
  const installedManifest = join(adaptersDir, 'java-junit.yaml');
  const installedExecutable = join(adaptersDir, 'java-junit.mjs');
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(installedManifest, readFileSync(manifest));
  writeFileSync(installedExecutable, readFileSync(executable));
  chmodSync(installedExecutable, 0o755);
  writeFileSync(
    join(root, ADAPTER_LOCK_RELPATH),
    serializeAdapterLock({
      version: 1,
      adapters: {
        'java-junit': {
          version: '1.2.3',
          manifest: '.crucible/adapters/java-junit.yaml',
          executable: '.crucible/adapters/java-junit.mjs',
          content_hash: hashAdapterPackage(installedManifest, installedExecutable),
        },
      },
    }),
    'utf8',
  );
}

describe('pinned adapter runtime', () => {
  it('loads the sole pin and spawns its installed executable', async () => {
    installAdapter();

    const client = loadPinnedAdapterClient(root);

    await expect(client.resolve(['com.acme.HelloTest#greets'])).resolves.toEqual([
      {
        target: 'com.acme.HelloTest#greets',
        status: 'found',
        targetFile: 'src/test/java/HelloTest.java',
      },
    ]);
  });

  it('fails closed before spawn when installed adapter bytes drift from the pin', () => {
    installAdapter();
    const executable = join(root, '.crucible', 'adapters', 'java-junit.mjs');
    writeFileSync(executable, readFileSync(executable, 'utf8') + '\n// tampered\n', 'utf8');

    try {
      loadPinnedAdapterClient(root);
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
      if (isCrucibleError(error)) {
        expect(error.exit).toBe(3);
        expect(error.code).toBe('ADAPTER_HASH_MISMATCH');
      }
      return;
    }
    throw new Error('expected adapter hash drift to fail closed');
  });
});
