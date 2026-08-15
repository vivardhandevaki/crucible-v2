import { describe, expect, it } from 'vitest';
import { buildProgram, P1_VERBS } from './program.js';
import { type RunnerIO, runProgram } from './runner.js';
import { parseTier } from '../commands/approve.cli.js';

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

  // Every P1 verb is now implemented (status landed with P1-14); no stubs remain.
  // The fail-closed stub loop stays in program.ts for any future unwired verb.
  const REAL_VERBS = ['approve', 'implement', 'propose', 'status', 'verify'];
  const STUB_VERBS = P1_VERBS.filter((v) => !REAL_VERBS.includes(v));

  it('every P1 verb is wired to a real command (no stubs remain)', () => {
    expect(STUB_VERBS).toEqual([]);
  });

  it('CI verify requires an authority manifest at its command boundary', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['ci', 'verify', 'add-greeting'], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain('--manifest');
  });

  it('CI route requires an authority manifest at its command boundary', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['ci', 'route'], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain('--manifest');
  });

  it.each(REAL_VERBS)(
    'real verb `%s`: no <change> arg → usage error (exit 2), not stub exit 4',
    async (verb) => {
      const cap = captureIO();
      const code = await runProgram(buildProgram(), [verb], cap.io);
      // A missing required argument is a usage/precondition failure, never exit 4.
      expect(code).toBe(2);
    },
  );

  it('registers the P2 `override` verb so it appears in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('override');
  });

  it('override with a change but no <reason> → exit 2 (P2-06 acceptance)', async () => {
    const cap = captureIO();
    // A missing required argument is a commander usage error the runner maps to
    // exit 2 — never a silent success or exit 4.
    const code = await runProgram(buildProgram(), ['override', 'some-change'], cap.io);
    expect(code).toBe(2);
  });

  it('registers the P2 `escalate` verb so it appears in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('escalate');
  });

  it('escalate with a change but no --question → exit 2 (required option)', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['escalate', 'some-change'], cap.io);
    expect(code).toBe(2);
  });

  it('registers the P2 `archive` verb so it appears in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('archive');
  });

  it('archive with no <change> argument → exit 2 (required argument)', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['archive'], cap.io);
    expect(code).toBe(2);
  });

  it('registers the P2 `doctor` verb so it appears in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('doctor');
  });

  it('doctor --help exposes the --yes fix-all flag (verb fully wired)', async () => {
    const cap = captureIO();
    const code = await runProgram(buildProgram(), ['doctor', '--help'], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain('--yes');
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
    // Global options are recorded before the subcommand's action runs; `status`
    // with no <change> raises a usage error (exitOverride), which we swallow — we
    // only assert the global option was captured.
    try {
      program.parse(['--config-from', '/tmp/target', 'status'], { from: 'user' });
    } catch {
      /* missing required <change> throws by design */
    }
    expect(program.opts().configFrom).toBe('/tmp/target');
  });

  it('advertises --config-from in help', async () => {
    const cap = captureIO();
    await runProgram(buildProgram(), ['--help'], cap.io);
    expect(cap.out()).toContain('--config-from');
  });
});

describe('approve --tier parsing (P4-17)', () => {
  it.each(['trivial', 'standard', 'critical'] as const)('accepts %s', (tier) => {
    expect(parseTier(tier)).toBe(tier);
  });

  it.each(['', 'CRITICAL', 'urgent', 'critical '])('rejects malformed tier %s', (tier) => {
    expect(() => parseTier(tier)).toThrow(/tier/i);
  });
});
