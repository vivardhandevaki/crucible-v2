// P3-06 acceptance — the explicit post-init lifecycle command is reachable as
// `crucible adapter add <manifest> <executable>` and the JVM init edge can find
// the first-party packaged bytes without importing adapter implementation code.

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildProgram } from './program.js';
import { type RunnerIO, runProgram } from './runner.js';
import { shippedAdapterPackage } from '../commands/init.cli.js';

function capture(): { io: RunnerIO; out: () => string } {
  const chunks: string[] = [];
  return {
    io: { writeOut: (text) => chunks.push(text), writeErr: () => {} },
    out: () => chunks.join(''),
  };
}

describe('adapter lifecycle CLI', () => {
  it('registers the nested adapter add command', async () => {
    const cap = capture();
    expect(await runProgram(buildProgram(), ['adapter', 'add', '--help'], cap.io)).toBe(0);
    expect(cap.out()).toContain('<manifest>');
    expect(cap.out()).toContain('<executable>');
  });

  it('resolves java-junit to the shipped manifest and single executable', () => {
    const pkg = shippedAdapterPackage('java-junit');
    expect(pkg).toBeDefined();
    expect(existsSync(pkg!.manifestPath)).toBe(true);
    expect(existsSync(pkg!.executablePath)).toBe(true);
    expect(pkg!.executablePath).toMatch(/java-junit\.mjs$/);
  });

  it('returns no invented package for an unknown adapter', () => {
    expect(shippedAdapterPackage('unknown')).toBeUndefined();
  });
});
