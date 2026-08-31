// P4R-09 acceptance — the adapter must discover against the build tool's
// evaluated test classpath and fail closed when that model cannot be obtained.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleTestClasspath,
  gradleTestClasspath,
  mavenDependencyClasspath,
  parseGradleTestClasspath,
  parseMavenDependencyClasspath,
} from './test-classpath.js';

describe('P4R-09 evaluated discovery classpaths', () => {
  it('preserves tool ordering, drops only later duplicates, and rejects malformed entries', () => {
    expect(parseMavenDependencyClasspath('/m2/a.jar:/m2/b.jar:/m2/a.jar', ':')).toEqual([
      '/m2/a.jar',
      '/m2/b.jar',
    ]);
    expect(() => parseMavenDependencyClasspath('/m2/a.jar::/m2/b.jar', ':')).toThrow(/non-empty/i);
    expect(parseGradleTestClasspath('["/classes/test", "/m2/a.jar", "/m2/a.jar"]')).toEqual([
      '/classes/test',
      '/m2/a.jar',
    ]);
    expect(() => parseGradleTestClasspath('{"classpath":[]}')).toThrow(/array/i);
    expect(() => parseGradleTestClasspath('["/classes/test", ""]')).toThrow(/non-empty/i);
    expect(() => parseGradleTestClasspath('["/classes/test", 1]')).toThrow(/string/i);
    expect(
      assembleTestClasspath(
        ['/project/test-output', '/project/main-output'],
        ['/m2/b.jar', '/m2/a.jar'],
      ),
    ).toEqual(['/project/test-output', '/project/main-output', '/m2/b.jar', '/m2/a.jar']);
  });

  it('aborts rather than degrading failed, absent, or malformed tool output to missing targets', () => {
    withTool('exit 9', (mvnBin, cwd) => {
      expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(/could not spawn|failed/i);
    });
    withTool('exit 0', (mvnBin, cwd) => {
      expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(
        /could not spawn|did not write/i,
      );
    });
    withTool(
      'for arg in "$@"; do case "$arg" in -Dmdep.outputFile=*) output="${arg#-Dmdep.outputFile=}";; esac; done\nprintf "/a::/b" > "$output"',
      (mvnBin, cwd) => {
        expect(() => mavenDependencyClasspath({ cwd, mvnBin })).toThrow(
          /could not spawn|non-empty/i,
        );
      },
    );
    withTool('exit 8', (gradleBin, cwd) => {
      expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(/could not spawn|failed/i);
    });
    withTool('exit 0', (gradleBin, cwd) => {
      expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(
        /could not spawn|did not write/i,
      );
    });
    withTool(
      'for arg in "$@"; do case "$arg" in -Dcrucible.test.classpath.output=*) output="${arg#-Dcrucible.test.classpath.output=}";; esac; done\nprintf "{}" > "$output"',
      (gradleBin, cwd) => {
        expect(() => gradleTestClasspath({ cwd, gradleBin })).toThrow(/could not spawn|array/i);
      },
    );
  });
});

function withTool(body: string, run: (bin: string, cwd: string) => void): void {
  // This test double must be executable; this environment mounts /tmp noexec.
  const cwd = mkdtempSync(join(process.cwd(), '.crucible-p4r-09-tool-'));
  const bin = join(cwd, 'tool');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(bin, 0o700);
  try {
    run(bin, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
