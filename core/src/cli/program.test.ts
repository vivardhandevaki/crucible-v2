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

  // approve is implemented (P1-07); the remaining verbs are still stubs.
  const STUB_VERBS = P1_VERBS.filter((v) => v !== 'approve');

  it.each(STUB_VERBS)('stub verb `%s` fails closed with exit 4', async (verb) => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), [verb], cap.io);
    // Invariant 3: a not-yet-implemented command must not silently succeed.
    expect(code).toBe(4);
  });

  it('`approve` is a real verb: no <change> arg → usage error (exit 2), not stub exit 4', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['approve'], cap.io);
    // A missing required argument is a usage/precondition failure, never exit 4.
    expect(code).toBe(2);
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

  it('parses --config-from into the program options (target-branch seam)', () => {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    // Global options are recorded before the subcommand's action runs; the
    // stub action throws (NOT_IMPLEMENTED), which we swallow — we only assert
    // the option was captured.
    try {
      program.parse(['--config-from', '/tmp/target', 'status'], { from: 'user' });
    } catch {
      /* stub verb throws by design */
    }
    expect(program.opts().configFrom).toBe('/tmp/target');
  });

  it('advertises --config-from in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('--config-from');
  });
});
