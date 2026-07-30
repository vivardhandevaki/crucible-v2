// P3-06 acceptance — the first-party adapter ships as one executable whose
// bytes include both the TypeScript wrapper and resolve-helper jar. The
// manifest stays beside it, while the executable sha256 must be byte-identical
// across two clean package builds so a committed lockfile pin is reproducible.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADAPTER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = join(ADAPTER_ROOT, 'package');
const EXECUTABLE = join(PACKAGE_DIR, 'java-junit.mjs');
const MANIFEST = join(PACKAGE_DIR, 'crucible-adapter.yaml');

const HAS_MVN = spawnSync('mvn', ['-v'], { encoding: 'utf8' }).status === 0;

function packageAdapter(): void {
  const result = spawnSync('npm', ['run', 'package'], {
    cwd: ADAPTER_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`package build failed:\n${result.stderr || result.stdout}`);
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(!HAS_MVN)('java-junit deterministic package', () => {
  it('emits one executable plus its manifest with byte-stable executable content', () => {
    packageAdapter();
    expect(existsSync(EXECUTABLE)).toBe(true);
    expect(existsSync(MANIFEST)).toBe(true);
    expect(statSync(EXECUTABLE).mode & 0o111).not.toBe(0);
    const first = sha256(EXECUTABLE);

    packageAdapter();
    const second = sha256(EXECUTABLE);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(readFileSync(EXECUTABLE, 'utf8')).toContain('CRUCIBLE_EMBEDDED_HELPER_JAR');
  }, 300_000);
});
