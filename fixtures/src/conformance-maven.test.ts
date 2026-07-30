// P3-04 acceptance — the java-junit adapter passes the conformance run on the
// maven-basic fixture. This is the payoff of "conformance maven-basic green":
// the REAL adapter (not the stub) satisfies the same universal checks the stub
// established as the protocol's executable spec (design phase-3.md §1/§1.1).
//
// The runner spawns the manifest's invocation strings verbatim from cwd=maven-
// basic, so this drives real `mvn` subprocesses. beforeAll builds the two things
// the run needs: the adapter's dist wrapper (spawned) and the bundled resolve-
// helper jar (digested by the package-hash check, and used by resolve). It skips
// wholesale when the JVM toolchain is absent — the adapter's own decline posture.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { CONFORMANCE_DIR, MAVEN_BASIC_DIR } from './index.js';
import { CONFORMANCE_CHECKS, hasFindings, runConformance } from '../conformance/run.js';

const FIXTURES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MONOREPO_ROOT = dirname(FIXTURES_ROOT);
const JAVA_JUNIT_DIR = join(MONOREPO_ROOT, 'adapters', 'java-junit');
const SCRIPT = join(CONFORMANCE_DIR, 'java-junit-maven.script.json');

const BUILD_TIMEOUT_MS = 300_000;

function hasTool(cmd: string, versionArg: string): boolean {
  return spawnSync(cmd, [versionArg], { encoding: 'utf8' }).status === 0;
}

const HAS_MVN = hasTool('java', '-version') && hasTool('mvn', '-v');

function runOrThrow(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `\`${cmd} ${args.join(' ')}\` in ${cwd} exited ${String(r.status)}:\n${r.stderr || r.stdout}`,
    );
  }
}

beforeAll(() => {
  if (!HAS_MVN) return;
  // P3-06's package target builds the helper and emits the one executable the
  // conformance script spawns and hashes. The next command warms the fixture.
  runOrThrow('npm', ['run', 'package'], JAVA_JUNIT_DIR);
  runOrThrow('mvn', ['-q', 'test-compile'], MAVEN_BASIC_DIR);
}, BUILD_TIMEOUT_MS);

describe.skipIf(!HAS_MVN)('java-junit conformance — maven-basic', () => {
  it(
    'passes the full conformance run with zero findings across all six checks',
    () => {
      const report = runConformance(SCRIPT);
      expect(report.adapter).toBe('java-junit-maven');
      for (const name of CONFORMANCE_CHECKS) {
        const c = report.checks.find((entry) => entry.check === name);
        expect(c, `report is missing the '${name}' check`).toBeDefined();
        expect(c!.evaluated, `${name} was not evaluated`).toBe(true);
        expect(
          c!.findings,
          `${name} produced findings:\n${JSON.stringify(c!.findings, null, 2)}`,
        ).toEqual([]);
      }
      expect(hasFindings(report)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'surfaces a stable package digest for every declared file (pin flow)',
    () => {
      const report = runConformance(SCRIPT);
      const digest = report.checks.find((c) => c.check === 'package-hash')?.digest;
      expect(digest, 'package-hash must surface a digest').toBeDefined();
      // One executable (wrapper + embedded jar) plus its manifest.
      expect(digest!.length).toBe(2);
      for (const entry of digest!) {
        expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
