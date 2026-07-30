// P3-03 acceptance — Launcher-API resolve helper (jar) + wrapper invocation.
//
// Drives the built helper jar through the `invokeResolve` wrapper against BOTH
// conformance fixtures (maven-basic + gradle-basic) and asserts:
//   - every declared target's three-way classification matches targets.json,
//     including the parameterized target → `unsupported`;
//   - `resolve` never executes a test — proven by a side-effect canary that
//     leaves no marker after resolve, and a positive control that shows the
//     marker DOES appear when the test body actually runs.
//
// The helper is a Maven project, so the suite builds the jar and compiles the
// fixtures in beforeAll; it skips wholesale when the JVM toolchain is absent
// (the same decline-when-no-JDK posture the adapter itself takes).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  GRADLE_BASIC_DIR,
  MAVEN_BASIC_DIR,
  loadConformanceTargets,
  type ConformanceTargetsManifest,
} from '@crucible/fixtures';

import { invokeResolve } from './resolve.js';

const WORKSPACE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESOLVE_HELPER_DIR = join(WORKSPACE_ROOT, 'resolve-helper');
const JAR_PATH = join(RESOLVE_HELPER_DIR, 'target', 'resolve-helper.jar');

const MAVEN_CP = [
  join(MAVEN_BASIC_DIR, 'target', 'classes'),
  join(MAVEN_BASIC_DIR, 'target', 'test-classes'),
];
const GRADLE_CP = [
  join(GRADLE_BASIC_DIR, 'build', 'classes', 'java', 'main'),
  join(GRADLE_BASIC_DIR, 'build', 'classes', 'java', 'test'),
];

function hasTool(cmd: string, versionArg: string): boolean {
  return spawnSync(cmd, [versionArg], { encoding: 'utf8' }).status === 0;
}

const HAS_JAVA = hasTool('java', '-version');
const HAS_MVN = HAS_JAVA && hasTool('mvn', '-v');
const HAS_GRADLE = HAS_JAVA && hasTool('gradle', '-version');

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
  // Build the jar under test (always fresh — it is the code under test) and
  // compile the fixtures' classes (incremental / up-to-date-fast).
  runOrThrow('mvn', ['-q', 'package'], RESOLVE_HELPER_DIR);
  runOrThrow('mvn', ['-q', 'test-compile'], MAVEN_BASIC_DIR);
  if (HAS_GRADLE) {
    runOrThrow('gradle', ['-q', 'testClasses', '--console=plain'], GRADLE_BASIC_DIR);
  }
}, 300_000);

function classificationByTarget(classpath: string[], manifest: ConformanceTargetsManifest) {
  const results = invokeResolve({
    jarPath: JAR_PATH,
    classpath,
    targets: manifest.targets.map((t) => t.target),
  });
  return new Map(results.map((r) => [r.target, r.classification]));
}

describe.skipIf(!HAS_MVN)('resolve helper — maven-basic', () => {
  it('classifies every declared target exactly as targets.json expects', async () => {
    const manifest = await loadConformanceTargets();
    const got = classificationByTarget(MAVEN_CP, manifest);
    for (const t of manifest.targets) {
      expect(got.get(t.target), `${t.target}`).toBe(t.resolve);
    }
  });

  it('classifies the parameterized target as unsupported', async () => {
    const manifest = await loadConformanceTargets();
    const parameterized = manifest.targets.find((t) => t.category === 'parameterized');
    expect(parameterized, 'manifest must declare a parameterized target').toBeDefined();
    const [result] = invokeResolve({
      jarPath: JAR_PATH,
      classpath: MAVEN_CP,
      targets: [parameterized!.target],
    });
    expect(result?.classification).toBe('unsupported');
  });

  it('never executes a test during resolve (side-effect canary)', async () => {
    const manifest = await loadConformanceTargets();
    const dir = mkdtempSync(join(tmpdir(), 'crucible-canary-'));
    const marker = join(dir, manifest.canary.markerFilename);
    try {
      // Resolve every target, canary included, with the canary directory set:
      // if resolve executed the body, the marker WOULD appear. It must not.
      invokeResolve({
        jarPath: JAR_PATH,
        classpath: MAVEN_CP,
        targets: manifest.targets.map((t) => t.target),
        systemProperties: { [manifest.canary.systemProperty]: dir },
      });
      expect(existsSync(marker), 'resolve must not execute the canary test').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('positive control: the canary marker appears when the test actually runs', async () => {
    const manifest = await loadConformanceTargets();
    const dir = mkdtempSync(join(tmpdir(), 'crucible-canary-exec-'));
    const marker = join(dir, manifest.canary.markerFilename);
    try {
      // Actually execute the canary test — proves the marker mechanism fires,
      // so the "absent after resolve" assertion above is meaningful.
      runOrThrow(
        'mvn',
        ['-q', '-Dtest=CanaryTest', `-Dcrucible.canary.dir=${dir}`, 'test'],
        MAVEN_BASIC_DIR,
      );
      expect(existsSync(marker), 'executing the canary must write the marker').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!(HAS_MVN && HAS_GRADLE))('resolve helper — gradle-basic', () => {
  it('classifies every declared target exactly as targets.json expects', async () => {
    const manifest = await loadConformanceTargets();
    const got = classificationByTarget(GRADLE_CP, manifest);
    for (const t of manifest.targets) {
      expect(got.get(t.target), `${t.target}`).toBe(t.resolve);
    }
  });
});
