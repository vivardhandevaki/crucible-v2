import { describe, expect, it } from 'vitest';
import { buildProgram, P1_VERBS } from './program.js';
import { type RunnerIO, runProgram } from './runner.js';

function captureIO(): { io: RunnerIO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      writeOut: (s) => outChunks.push(s),
      writeErr: (s) => errChunks.push(s),
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

describe('buildProgram', () => {
  it('registers every P1 verb so it appears in help', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['--help'], cap.io);
    expect(code).toBe(0);
    for (const verb of P1_VERBS) {
      expect(cap.out()).toContain(verb);
    }
  });

  it('exposes exactly the P1 tracer verbs', () => {
    expect([...P1_VERBS].sort()).toEqual(
      ['approve', 'implement', 'propose', 'status', 'verify'].sort(),
    );
  });

  it.each([...P1_VERBS])('stub verb `%s` fails closed with exit 4', async (verb) => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), [verb], cap.io);
    // Invariant 3: a not-yet-implemented command must not silently succeed.
    expect(code).toBe(4);
  });

  it('unknown command against the real program → exit 2 with help + hint', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['frobnicate'], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toContain('frobnicate');
    expect(cap.err().toLowerCase()).toContain('--help');
  });

  it('--version exits 0', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['--version'], cap.io);
    expect(code).toBe(0);
    expect(cap.out().trim().length).toBeGreaterThan(0);
  });
});
