// P3-05 acceptance — the java-junit adapter passes the conformance run on the
// gradle-basic fixture. The payoff of "conformance gradle-basic green": the REAL
// adapter satisfies the same six universal checks on Gradle that P3-04 proved on
// Maven, driven by the same manifest and the same shared normalizer (design
// phase-3.md §1/§1.1, §2). Mirrors conformance-maven.test.ts.
//
// The runner spawns the manifest's invocation strings verbatim from cwd=gradle-
// basic, so this drives real `gradle` subprocesses. beforeAll builds the adapter
// dist wrapper (spawned) and the bundled resolve-helper jar (digested by the
// package-hash check, and used by resolve) and warms the fixture's compile. It
// skips wholesale when the JVM/Gradle toolchain is absent — the adapter's own
// decline posture.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { CONFORMANCE_DIR, GRADLE_BASIC_DIR } from './index.js';
import { CONFORMANCE_CHECKS, hasFindings, runConformance } from '../conformance/run.js';

const FIXTURES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MONOREPO_ROOT = dirname(FIXTURES_ROOT);
const JAVA_JUNIT_DIR = join(MONOREPO_ROOT, 'adapters', 'java-junit');
const SCRIPT = join(CONFORMANCE_DIR, 'java-junit-gradle.script.json');

const BUILD_TIMEOUT_MS = 300_000;

function hasTool(cmd: string, versionArg: string): boolean {
  return spawnSync(cmd, [versionArg], { encoding: 'utf8' }).status === 0;
}

const HAS_JAVA = hasTool('java', '-version');
const HAS_GRADLE = HAS_JAVA && hasTool('gradle', '-version');
// The resolve-helper jar is built with Maven (its own project), so the run needs
// Maven too — the same prerequisite the P3-03/P3-04 suites carry.
const HAS_MVN = HAS_JAVA && hasTool('mvn', '-v');
const CAN_RUN = HAS_GRADLE && HAS_MVN;

function runOrThrow(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `\`${cmd} ${args.join(' ')}\` in ${cwd} exited ${String(r.status)}:\n${r.stderr || r.stdout}`,
    );
  }
}

beforeAll(() => {
  if (!CAN_RUN) return;
  // P3-06's package target builds the helper and emits the one executable the
  // conformance script spawns and hashes. The next command warms the fixture.
  runOrThrow('npm', ['run', 'package'], JAVA_JUNIT_DIR);
  runOrThrow('gradle', ['-q', 'testClasses', '--console=plain'], GRADLE_BASIC_DIR);
}, BUILD_TIMEOUT_MS);

describe.skipIf(!CAN_RUN)('java-junit conformance — gradle-basic', () => {
  it(
    'passes the full conformance run with zero findings across all six checks',
    () => {
      const report = runConformance(SCRIPT);
      expect(report.adapter).toBe('java-junit-gradle');
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
