// P4-12 acceptance — strict parsing for build-tool-emitted discovery classpaths.
// The build drivers own process invocation; this small pure seam pins the
// deterministic ordering and malformed-output posture independently.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleTestClasspath,
  gradleTestClasspath,
  mavenDependencyClasspath,
  parseGradleTestClasspath,
  parseMavenDependencyClasspath,
} from './test-classpath.js';

describe('P4-12 discovery classpath parsing', () => {
  it('preserves Maven-emitted order and removes only later duplicates', () => {
    expect(parseMavenDependencyClasspath('/m2/a.jar:/m2/b.jar:/m2/a.jar', ':')).toEqual([
      '/m2/a.jar',
      '/m2/b.jar',
    ]);
  });

  it('rejects malformed Maven delimiter output', () => {
    expect(() => parseMavenDependencyClasspath('/m2/a.jar::/m2/b.jar', ':')).toThrow(/non-empty/i);
  });

  it('accepts only a JSON array of non-empty Gradle classpath strings', () => {
    expect(parseGradleTestClasspath('["/classes/test", "/m2/a.jar", "/m2/a.jar"]')).toEqual([
      '/classes/test',
      '/m2/a.jar',
    ]);
    expect(() => parseGradleTestClasspath('{"classpath":[]}')).toThrow(/array/i);
    expect(() => parseGradleTestClasspath('["/classes/test", ""]')).toThrow(/non-empty/i);
    expect(() => parseGradleTestClasspath('["/classes/test", 1]')).toThrow(/string/i);
  });

  it('puts test output ahead of main output and dependencies without reordering either source', () => {
    expect(
      assembleTestClasspath(
        ['/project/test-output', '/project/main-output'],
        ['/m2/b.jar', '/m2/a.jar'],
      ),
    ).toEqual(['/project/test-output', '/project/main-output', '/m2/b.jar', '/m2/a.jar']);
  });
});

const HAS_GRADLE = spawnSync('gradle', ['-version'], { encoding: 'utf8' }).status === 0;

describe('P4-12 build-tool classpath failure posture', () => {
  it('rejects Maven tool failure, missing output, malformed output, and nonexistent dependencies', () => {
    withTool('exit 9', (mvnBin, cwd) => {
      expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(/failed/i);
    });
    withTool('exit 0', (mvnBin, cwd) => {
      expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(/did not write/i);
    });
    withTool(
      'for arg in "$@"; do case "$arg" in -Dmdep.outputFile=*) output="${arg#-Dmdep.outputFile=}";; esac; done\nprintf "/a::/b" > "$output"',
      (mvnBin, cwd) => {
        expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(/non-empty/i);
      },
    );
    withTool(
      'for arg in "$@"; do case "$arg" in -Dmdep.outputFile=*) output="${arg#-Dmdep.outputFile=}";; esac; done\nprintf "/definitely/missing.jar" > "$output"',
      (mvnBin, cwd) => {
        expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(/does not exist/i);
      },
    );
  });

  it('rejects Gradle tool failure, missing output, and malformed model output', () => {
    withTool('exit 8', (gradleBin, cwd) => {
      expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(/failed/i);
    });
    withTool('exit 0', (gradleBin, cwd) => {
      expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(/did not write/i);
    });
    withTool(
      'for arg in "$@"; do case "$arg" in -Dcrucible.test.classpath.output=*) output="${arg#-Dcrucible.test.classpath.output=}";; esac; done\nprintf "{}" > "$output"',
      (gradleBin, cwd) => {
        expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(/array/i);
      },
    );
  });
  it.skipIf(!HAS_GRADLE)(
    'rejects a root project with no Test task',
    () => {
      const cwd = mkdtempSync(join(tmpdir(), 'crucible-p4-12-no-test-task-'));
      try {
        writeFileSync(join(cwd, 'settings.gradle'), "rootProject.name = 'no-test-task'\n", 'utf8');
        expect(() => gradleTestClasspath({ cwd })).toThrow(/missing or is not a Test task/i);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

function withTool(body: string, run: (bin: string, cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'crucible-p4-12-tool-'));
  const bin = join(cwd, 'tool');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(bin, 0o700);
  try {
    run(bin, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
