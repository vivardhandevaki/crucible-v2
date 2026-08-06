// P3-04 acceptance — Maven driver integration (JDK-gated). The conformance run
// (fixtures/src/conformance-maven.test.ts) covers the happy path against the
// shared fixture; this file pins the two error-posture clauses that conformance
// does not exercise:
//   - a compile error BEFORE tests run → ALL requested targets `error`, each
//     carrying the build-log tail (fail-closed, attributable — design §2);
//   - a run whose targets simply are not found → per-target `error`, not a crash.
//
// It builds a throwaway copy of the maven-basic sources in a temp dir so it can
// break one on purpose without touching the shared fixture.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAVEN_BASIC_DIR } from '@crucible/fixtures';

import { resolveMaven, runMaven } from './maven.js';
import { invokeResolve } from './resolve.js';

function hasTool(cmd: string, versionArg: string): boolean {
  return spawnSync(cmd, [versionArg], { encoding: 'utf8' }).status === 0;
}

const HAS_MVN = hasTool('java', '-version') && hasTool('mvn', '-v');

const ADD = 'com.crucible.conformance.CalculatorTest#addsTwoNumbers';
const FAIL = 'com.crucible.conformance.CalculatorTest#failsOnPurpose';
const ADAPTER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JAR_PATH = join(ADAPTER_ROOT, 'resolve-helper', 'target', 'resolve-helper.jar');
const MONOREPO_ROOT = dirname(dirname(ADAPTER_ROOT));
const SPRING_HELLO_WORLD_DIR = join(MONOREPO_ROOT, 'fixtures', 'spring-hello-world');
const MOCKMVC_TARGET = 'com.crucible.hello.MockMvcDiscoveryTest#resolvesWithoutExecution';
const MOCKMVC_TEST = join('src/test/java/com/crucible/hello/MockMvcDiscoveryTest.java');

let happy: string;
beforeAll(() => {
  if (!HAS_MVN) return;
  happy = mkdtempSync(join(tmpdir(), 'crucible-mvn-happy-'));
  cpSync(join(MAVEN_BASIC_DIR, 'pom.xml'), join(happy, 'pom.xml'));
  cpSync(join(MAVEN_BASIC_DIR, 'src'), join(happy, 'src'), { recursive: true });
});
afterAll(() => {
  if (happy) rmSync(happy, { recursive: true, force: true });
});

describe.skipIf(!HAS_MVN)('runMaven — happy path', () => {
  it('normalizes pass/fail and reports a not-found target as error', () => {
    const results = runMaven({
      cwd: happy,
      targets: [ADD, FAIL, 'com.crucible.conformance.CalculatorTest#doesNotExist'],
    });
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'error']);
    // Order is preserved and each requested target is answered exactly once.
    expect(results.map((r) => r.target)).toEqual([
      ADD,
      FAIL,
      'com.crucible.conformance.CalculatorTest#doesNotExist',
    ]);
  }, 300_000);
});

describe.skipIf(!HAS_MVN)('runMaven — compile error before tests run', () => {
  let broken: string;

  beforeAll(() => {
    if (!HAS_MVN) return;
    broken = mkdtempSync(join(tmpdir(), 'crucible-mvn-broken-'));
    // Copy just the project sources (not target/) so Maven recompiles cleanly.
    cpSync(join(MAVEN_BASIC_DIR, 'pom.xml'), join(broken, 'pom.xml'));
    cpSync(join(MAVEN_BASIC_DIR, 'src'), join(broken, 'src'), { recursive: true });
    // Introduce a genuine compile error in a MAIN source (breaks test-compile).
    writeFileSync(
      join(broken, 'src', 'main', 'java', 'com', 'crucible', 'conformance', 'Calculator.java'),
      'package com.crucible.conformance;\npublic class Calculator { this is not valid java }\n',
    );
  }, 60_000);

  afterAll(() => {
    if (broken) rmSync(broken, { recursive: true, force: true });
  });

  it('maps every requested target to error with the build-log tail', () => {
    const results = runMaven({ cwd: broken, targets: [ADD, FAIL] });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe('error');
      // The build-log tail is attached (fail-closed + attributable).
      expect(r.message).toMatch(/build failed before tests ran/);
      expect(r.message).toMatch(/ERROR|BUILD FAILURE|Calculator\.java/);
    }
  }, 300_000);
});

describe.skipIf(!HAS_MVN)('resolveMaven — dependency-backed Spring discovery (P4-12)', () => {
  let spring: string;

  beforeAll(() => {
    spring = mkdtempSync(join(tmpdir(), 'crucible-mvn-mockmvc-'));
    cpSync(SPRING_HELLO_WORLD_DIR, spring, { recursive: true });
    const source = join(spring, MOCKMVC_TEST);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(
      source,
      [
        'package com.crucible.hello;',
        '',
        'import java.nio.file.Files;',
        'import java.nio.file.Path;',
        'import org.junit.jupiter.api.Test;',
        'import org.springframework.beans.factory.annotation.Autowired;',
        'import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;',
        'import org.springframework.boot.test.context.SpringBootTest;',
        'import org.springframework.test.web.servlet.MockMvc;',
        'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;',
        '',
        '@SpringBootTest',
        '@AutoConfigureMockMvc',
        'class MockMvcDiscoveryTest {',
        '  @Autowired MockMvc mockMvc;',
        '',
        '  @Test',
        '  void resolvesWithoutExecution() throws Exception {',
        '    mockMvc.perform(post("/notes"));',
        '    Files.writeString(Path.of("target", "p4-12-mockmvc-executed"), "executed");',
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
    if (spring) rmSync(spring, { recursive: true, force: true });
  });

  it('loads MockMvc dependencies, grounds the target, and never executes its body', () => {
    const compiled = spawnSync('mvn', ['-q', 'test-compile'], { cwd: spring, encoding: 'utf8' });
    if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout);
    expect(() =>
      invokeResolve({
        jarPath: JAR_PATH,
        classpath: [join(spring, 'target', 'classes'), join(spring, 'target', 'test-classes')],
        targets: [MOCKMVC_TARGET],
      }),
    ).toThrow(/RequestBuilder/);

    expect(resolveMaven({ cwd: spring, targets: [MOCKMVC_TARGET], jarPath: JAR_PATH })).toEqual([
      { target: MOCKMVC_TARGET, status: 'found', targetFile: MOCKMVC_TEST },
    ]);
    expect(existsSync(join(spring, 'target', 'p4-12-mockmvc-executed'))).toBe(false);
  }, 300_000);
});
