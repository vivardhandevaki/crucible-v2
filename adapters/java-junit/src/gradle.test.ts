// P3-05 acceptance — Gradle driver integration (JDK+Gradle-gated). The
// conformance run (fixtures/src/conformance-gradle.test.ts) covers the happy
// path against the shared fixture; this file pins the two error-posture clauses
// conformance does not exercise, mirroring maven.test.ts so both build tools'
// drivers are held to the same bar:
//   - a compile error BEFORE tests run → ALL requested targets `error`, each
//     carrying the build-log tail (fail-closed, attributable — design §2);
//   - a run whose targets simply are not found → per-target `error`, not a crash.
//
// It builds a throwaway copy of the gradle-basic sources in a temp dir so it can
// break one on purpose without touching the shared fixture.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GRADLE_BASIC_DIR } from '@crucible/fixtures';

import { resolveGradle, runGradle } from './gradle.js';

function hasTool(cmd: string, versionArg: string): boolean {
  return spawnSync(cmd, [versionArg], { encoding: 'utf8' }).status === 0;
}

const HAS_GRADLE = hasTool('java', '-version') && hasTool('gradle', '-version');

const ADD = 'com.crucible.conformance.CalculatorTest#addsTwoNumbers';
const FAIL = 'com.crucible.conformance.CalculatorTest#failsOnPurpose';
const SKIP = 'com.crucible.conformance.CalculatorTest#skippedFeature';
const MISSING = 'com.crucible.conformance.CalculatorTest#doesNotExist';

const ADAPTER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JAR_PATH = join(ADAPTER_ROOT, 'resolve-helper', 'target', 'resolve-helper.jar');
const CUSTOM_TARGET =
  'com.crucible.conformance.CustomClasspathDiscoveryTest#resolvesWithoutExecution';
const CUSTOM_TEST = join(
  'src/test/java/com/crucible/conformance/CustomClasspathDiscoveryTest.java',
);

let happy: string;
beforeAll(() => {
  if (!HAS_GRADLE) return;
  happy = mkdtempSync(join(tmpdir(), 'crucible-gradle-happy-'));
  for (const entry of ['build.gradle', 'settings.gradle', 'src']) {
    cpSync(join(GRADLE_BASIC_DIR, entry), join(happy, entry), { recursive: true });
  }
});
afterAll(() => {
  if (happy) rmSync(happy, { recursive: true, force: true });
});

describe.skipIf(!HAS_GRADLE)('runGradle — happy path', () => {
  it('normalizes pass/fail/skip and reports a not-found target as error', () => {
    const results = runGradle({ cwd: happy, targets: [ADD, FAIL, SKIP, MISSING] });
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'skip', 'error']);
    // Order is preserved and each requested target is answered exactly once.
    expect(results.map((r) => r.target)).toEqual([ADD, FAIL, SKIP, MISSING]);
  }, 300_000);
});

describe.skipIf(!HAS_GRADLE)('runGradle — compile error before tests run', () => {
  let broken: string;

  beforeAll(() => {
    if (!HAS_GRADLE) return;
    broken = mkdtempSync(join(tmpdir(), 'crucible-gradle-broken-'));
    // Copy just the project sources (not build/) so Gradle recompiles cleanly.
    for (const entry of ['build.gradle', 'settings.gradle', 'src']) {
      cpSync(join(GRADLE_BASIC_DIR, entry), join(broken, entry), { recursive: true });
    }
    // Introduce a genuine compile error in a MAIN source (breaks compileJava).
    writeFileSync(
      join(broken, 'src', 'main', 'java', 'com', 'crucible', 'conformance', 'Calculator.java'),
      'package com.crucible.conformance;\npublic class Calculator { this is not valid java }\n',
    );
  }, 60_000);

  afterAll(() => {
    if (broken) rmSync(broken, { recursive: true, force: true });
  });

  it('maps every requested target to error with the build-log tail', () => {
    const results = runGradle({ cwd: broken, targets: [ADD, FAIL] });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe('error');
      // The build-log tail is attached (fail-closed + attributable).
      expect(r.message).toMatch(/build failed before tests ran/);
      expect(r.message).toMatch(/error|FAILED|Calculator\.java|compileJava/i);
    }
  }, 300_000);
});

describe.skipIf(!HAS_GRADLE)('resolveGradle — configured Test.classpath (P4-12)', () => {
  let customized: string;

  beforeAll(() => {
    customized = mkdtempSync(join(tmpdir(), 'crucible-gradle-classpath-'));
    for (const entry of ['build.gradle', 'settings.gradle', 'src']) {
      cpSync(join(GRADLE_BASIC_DIR, entry), join(customized, entry), { recursive: true });
    }
    appendFileSync(
      join(customized, 'build.gradle'),
      [
        '',
        'configurations { p412DiscoveryOnly }',
        'dependencies {',
        "  testCompileOnly 'org.apache.commons:commons-lang3:3.17.0'",
        "  p412DiscoveryOnly 'org.apache.commons:commons-lang3:3.17.0'",
        '}',
        "tasks.named('test') { classpath = classpath + configurations.p412DiscoveryOnly }",
        '',
      ].join('\n'),
      'utf8',
    );
    const source = join(customized, CUSTOM_TEST);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(
      source,
      [
        'package com.crucible.conformance;',
        '',
        'import java.nio.file.Files;',
        'import java.nio.file.Path;',
        'import org.apache.commons.lang3.function.FailableRunnable;',
        'import org.junit.jupiter.api.Test;',
        '',
        'class CustomClasspathDiscoveryTest implements FailableRunnable<Exception> {',
        '  @Override public void run() {}',
        '',
        '  @Test',
        '  void resolvesWithoutExecution() throws Exception {',
        '    Files.writeString(Path.of("build", "p4-12-custom-classpath-executed"), "executed");',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const helper = spawnSync('mvn', ['-q', 'package'], {
      cwd: join(ADAPTER_ROOT, 'resolve-helper'),
      encoding: 'utf8',
    });
    if (helper.status !== 0) throw new Error(helper.stderr || helper.stdout);
  }, 300_000);

  afterAll(() => {
    if (customized) rmSync(customized, { recursive: true, force: true });
  });

  it('uses the configured task classpath, grounds the target, and never executes its body', () => {
    expect(resolveGradle({ cwd: customized, targets: [CUSTOM_TARGET], jarPath: JAR_PATH })).toEqual(
      [{ target: CUSTOM_TARGET, status: 'found', targetFile: CUSTOM_TEST }],
    );
    expect(existsSync(join(customized, 'build', 'p4-12-custom-classpath-executed'))).toBe(false);
  }, 300_000);
});
