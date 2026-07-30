// P3-01 acceptance — JVM conformance fixtures (maven-basic + gradle-basic).
//
// Two layers:
//   1. Manifest consistency (fast, always runs): targets.json declares all five
//      categories and each target's resolve/run expectations follow the design's
//      rules (design phase-3.md §1). This is the "documented" half of acceptance.
//   2. Build + run (guarded on tool availability): each fixture actually builds
//      and runs under plain `mvn test` / `gradle test`, and every plain-@Test
//      target's real outcome in the JUnit XML matches the manifest. This is the
//      "both build + run" half. Skipped when the JVM toolchain is absent — the
//      same decline-when-no-JDK posture the adapter itself takes.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GRADLE_BASIC_DIR,
  MAVEN_BASIC_DIR,
  loadConformanceTargets,
  type ConformanceCategory,
  type ConformanceTarget,
} from './index.js';

const BUILD_TIMEOUT_MS = 300_000;

function hasTool(cmd: string, versionArg: string): boolean {
  const r = spawnSync(cmd, [versionArg], { encoding: 'utf8' });
  return r.status === 0;
}

const HAS_JAVA = hasTool('java', '-version');
const HAS_MVN = HAS_JAVA && hasTool('mvn', '-v');
const HAS_GRADLE = HAS_JAVA && hasTool('gradle', '-version');

/** One test outcome parsed from a JUnit `<testcase>` element. */
type XmlStatus = 'pass' | 'fail' | 'error' | 'skip';

/** Parse every `<testcase>` in a directory of JUnit XML into `classname#name → status`. */
function parseJunitXmlDir(dir: string): Map<string, XmlStatus[]> {
  const byTarget = new Map<string, XmlStatus[]>();
  const files = readdirSync(dir).filter((f) => f.startsWith('TEST-') && f.endsWith('.xml'));
  for (const file of files) {
    const xml = readFileSync(join(dir, file), 'utf8');
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = m[1] ?? '';
      const body = m[3] ?? '';
      const rawName = /\bname="([^"]*)"/.exec(attrs)?.[1];
      const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1];
      if (rawName === undefined || classname === undefined) continue;
      // Normalize the build-tool XML dialects: Gradle names plain methods with
      // empty trailing parens (`addsTwoNumbers()`), Surefire without. (The full
      // shared normalizer is P3-05; here we only need the plain-method key.)
      const name = rawName.replace(/\(\)$/, '');
      let status: XmlStatus = 'pass';
      if (/<failure\b/.test(body)) status = 'fail';
      else if (/<error\b/.test(body)) status = 'error';
      else if (/<skipped\b/.test(body)) status = 'skip';
      const key = `${classname}#${name}`;
      const list = byTarget.get(key) ?? [];
      list.push(status);
      byTarget.set(key, list);
    }
  }
  return byTarget;
}

/** Assert one fixture built + ran, and each plain-@Test target's outcome matches the manifest. */
function assertFixtureOutcomes(targets: ConformanceTarget[], xmlDir: string): void {
  const parsed = parseJunitXmlDir(xmlDir);
  for (const t of targets) {
    // Only plain, addressable methods with a concrete run outcome appear as a
    // single testcase keyed by method name. Parameterized (template → many
    // invocations) and missing (no such test) are asserted structurally, not here.
    if (t.category === 'parameterized' || t.category === 'missing' || t.run === null) continue;
    const statuses = parsed.get(t.target);
    expect(statuses, `no <testcase> for ${t.target} in ${xmlDir}`).toBeDefined();
    expect(statuses).toHaveLength(1);
    expect(statuses?.[0], `${t.target} expected run=${t.run}`).toBe(t.run);
  }
}

describe('JVM conformance manifest (targets.json)', () => {
  it('declares all five categories', async () => {
    const manifest = await loadConformanceTargets();
    const categories = new Set<ConformanceCategory>(manifest.targets.map((t) => t.category));
    expect([...categories].sort()).toEqual(['fail', 'missing', 'parameterized', 'pass', 'skip']);
  });

  it('each target follows the design §1 resolve/run rules', async () => {
    const manifest = await loadConformanceTargets();
    for (const t of manifest.targets) {
      switch (t.category) {
        case 'pass':
          expect([t.resolve, t.run]).toEqual(['found', 'pass']);
          break;
        case 'fail':
          expect([t.resolve, t.run]).toEqual(['found', 'fail']);
          break;
        case 'skip':
          // resolve discovers @Disabled tests; skip is a runtime outcome only.
          expect([t.resolve, t.run]).toEqual(['found', 'skip']);
          break;
        case 'parameterized':
          // excluded from addressing: unsupported at resolve, no run outcome.
          expect([t.resolve, t.run]).toEqual(['unsupported', null]);
          break;
        case 'missing':
          expect([t.resolve, t.run]).toEqual(['missing', 'error']);
          break;
      }
    }
  });

  it('the canary target is a declared, addressable pass target', async () => {
    const manifest = await loadConformanceTargets();
    const canary = manifest.targets.find((t) => t.target === manifest.canary.target);
    expect(canary, 'canary.target must appear in targets[]').toBeDefined();
    expect(canary?.category).toBe('pass');
    expect(canary?.resolve).toBe('found');
  });
});

describe.skipIf(!HAS_MVN)('maven-basic builds + runs under `mvn test`', () => {
  it(
    'runs every test; plain-@Test outcomes match the manifest',
    async () => {
      const r = spawnSync('mvn', ['-q', '-Dmaven.test.failure.ignore=true', 'test'], {
        cwd: MAVEN_BASIC_DIR,
        encoding: 'utf8',
      });
      // failure.ignore keeps the exit at 0 while writing complete XML; a non-zero
      // status here means the build itself broke (compile error, missing dep).
      expect(r.status, r.stderr || r.stdout).toBe(0);
      const manifest = await loadConformanceTargets();
      assertFixtureOutcomes(manifest.targets, join(MAVEN_BASIC_DIR, 'target', 'surefire-reports'));
    },
    BUILD_TIMEOUT_MS,
  );
});

describe.skipIf(!HAS_GRADLE)('gradle-basic builds + runs under `gradle test`', () => {
  it(
    'runs every test; plain-@Test outcomes match the manifest',
    async () => {
      // --rerun-tasks defeats Gradle's up-to-date cache so XML is always fresh;
      // the intentional FAIL makes the task exit non-zero, so status is not 0.
      const r = spawnSync('gradle', ['test', '--rerun-tasks', '-q', '--console=plain'], {
        cwd: GRADLE_BASIC_DIR,
        encoding: 'utf8',
      });
      // Exit 1 (test failure) is expected; only a >1 / null status is a real break.
      expect(r.status === 0 || r.status === 1, r.stderr || r.stdout).toBe(true);
      const manifest = await loadConformanceTargets();
      assertFixtureOutcomes(
        manifest.targets,
        join(GRADLE_BASIC_DIR, 'build', 'test-results', 'test'),
      );
    },
    BUILD_TIMEOUT_MS,
  );
});
