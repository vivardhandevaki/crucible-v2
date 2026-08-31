import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FRAMEWORK_BIN_RELPATH,
  FRAMEWORK_PACKAGE_RELPATH,
  installFrameworkDistribution,
  packageFrameworkDistribution,
  resolveFrameworkEntrypoint,
} from './distribution.js';
import { loadFrameworkPin } from './pin.js';
import { isCrucibleError } from '../util/errors.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-framework-distribution-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function makeBuiltFramework(): string {
  const source = join(scratch, 'source');
  mkdirSync(join(source, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(source, 'dist', 'commands'), { recursive: true });
  mkdirSync(join(source, 'assets', 'context'), { recursive: true });
  writeFileSync(
    join(source, 'dist', 'cli', 'bin.js'),
    'process.stdout.write("local framework\\n");\n',
    {
      encoding: 'utf8',
    },
  );
  writeFileSync(join(source, 'dist', 'commands', 'init.js'), 'export {};\n', 'utf8');
  writeFileSync(join(source, 'assets', 'context', 'propose.md'), '# Role: propose\n', 'utf8');
  writeFileSync(join(source, 'openspec.cjs'), 'process.exitCode = 0;\n', 'utf8');
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: '@crucible/core', version: '1.2.3' }) + '\n',
    'utf8',
  );
  return source;
}

describe('project-local framework distribution', () => {
  it('packages built JavaScript deterministically and installs a pinned local launcher', () => {
    const source = makeBuiltFramework();
    const first = join(scratch, 'first-package');
    const second = join(scratch, 'second-package');
    const firstReport = packageFrameworkDistribution({ source, output: first });
    const secondReport = packageFrameworkDistribution({ source, output: second });

    expect(firstReport.pin).toEqual(secondReport.pin);
    expect(readFileSync(join(first, 'framework-manifest.json'), 'utf8')).toBe(
      readFileSync(join(second, 'framework-manifest.json'), 'utf8'),
    );

    const consumer = join(scratch, 'java-only-consumer');
    const report = installFrameworkDistribution({ root: consumer, source: first });
    expect(loadFrameworkPin(join(consumer, '.crucible', 'framework.lock.json'))).toEqual(
      report.pin,
    );
    expect(existsSync(join(consumer, FRAMEWORK_PACKAGE_RELPATH, 'crucible.mjs'))).toBe(true);
    expect(existsSync(join(consumer, FRAMEWORK_BIN_RELPATH))).toBe(true);

    const invoked = spawnSync(process.execPath, [join(consumer, FRAMEWORK_BIN_RELPATH)], {
      cwd: consumer,
      encoding: 'utf8',
    });
    expect(invoked.status).toBe(0);
  });

  it.each([
    [
      'missing',
      (root: string) => rmSync(join(root, FRAMEWORK_PACKAGE_RELPATH), { recursive: true }),
    ],
    [
      'mismatched',
      (root: string) =>
        writeFileSync(join(root, FRAMEWORK_PACKAGE_RELPATH, 'crucible.mjs'), 'tampered\n'),
    ],
    [
      'mutable',
      (root: string) => {
        const lock = join(root, '.crucible', 'framework.lock.json');
        writeFileSync(lock, readFileSync(lock, 'utf8').replace('"1.2.3"', '"^1.2.3"'));
      },
    ],
  ])('rejects a %s local pin without consulting an ambient executable', (_name, mutate) => {
    const source = makeBuiltFramework();
    const packaged = join(scratch, 'package');
    packageFrameworkDistribution({ source, output: packaged });
    const consumer = join(scratch, 'consumer');
    installFrameworkDistribution({ root: consumer, source: packaged });
    mutate(consumer);

    try {
      resolveFrameworkEntrypoint(consumer);
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
      return;
    }
    throw new Error('expected the local launcher preflight to fail');
  });

  it('rejects framework packaging when workspace build output is absent', () => {
    const source = join(scratch, 'unbuilt');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"@crucible/core","version":"1.2.3"}\n');
    expect(() =>
      packageFrameworkDistribution({ source, output: join(scratch, 'package') }),
    ).toThrow(/built JavaScript/i);
  });

  it('initializes and proposes from the built local package in a Java-only consumer', () => {
    const consumer = join(scratch, 'java-only');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, 'pom.xml'), '<project/>\n', 'utf8');
    const packagedRelease = join(process.cwd(), 'core', 'package');
    installFrameworkDistribution({ root: consumer, source: packagedRelease });

    const init = spawnSync(
      process.execPath,
      [join(consumer, FRAMEWORK_BIN_RELPATH), 'init', '--yes'],
      {
        cwd: consumer,
        encoding: 'utf8',
      },
    );
    expect(init.status).toBe(0);
    expect(existsSync(join(consumer, 'package.json'))).toBe(false);

    const propose = spawnSync(
      process.execPath,
      [join(consumer, FRAMEWORK_BIN_RELPATH), 'propose', 'example'],
      {
        cwd: consumer,
        encoding: 'utf8',
      },
    );
    expect(propose.status).toBe(0);
  });
});
