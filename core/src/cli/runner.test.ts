import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { internalError, invalidInputError, preconditionError } from './errors.js';
import { type RunnerIO, runProgram } from './runner.js';

// Capturing IO so the runner can be exercised without touching process
// streams or calling process.exit (which would kill the test worker).
function captureIO(): {
  io: RunnerIO;
  out: () => string;
  err: () => string;
} {
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

// A single-command program whose action throws whatever we hand it. This lets
// us drive every error path through the real runner independently of the
// still-stubbed P1 command modules.
function throwingProgram(thrown: unknown): Command {
  const program = new Command();
  program.name('crucible');
  program.option('--json', 'emit machine-readable JSON output');
  program
    .command('boom')
    .description('test command that throws')
    .action(() => {
      throw thrown;
    });
  program
    .command('ok')
    .description('test command that succeeds')
    .action(() => {
      // no-op success
    });
  return program;
}

describe('runProgram exit-code mapping', () => {
  it('returns 0 on a successful command', async () => {
    const cap = captureIO();
    const code = await runProgram(throwingProgram(undefined), ['ok'], cap.io);
    expect(code).toBe(0);
  });

  it('maps a thrown precondition CrucibleError to exit 2 with its hint', async () => {
    const cap = captureIO();
    const code = await runProgram(
      throwingProgram(preconditionError('NO_APPROVAL', 'not approved', 'Run `crucible approve`.')),
      ['boom'],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.err()).toContain('not approved');
    expect(cap.err()).toContain('Run `crucible approve`.');
  });

  it('maps a thrown invalid-input CrucibleError to exit 3', async () => {
    const cap = captureIO();
    const code = await runProgram(
      throwingProgram(invalidInputError('BAD_ORACLE', 'oracle malformed', 'Fix oracles.md.')),
      ['boom'],
      cap.io,
    );
    expect(code).toBe(3);
    expect(cap.err()).toContain('oracle malformed');
  });

  it('maps a thrown internal CrucibleError to exit 4', async () => {
    const cap = captureIO();
    const code = await runProgram(
      throwingProgram(internalError('BUG', 'invariant broken', '')),
      ['boom'],
      cap.io,
    );
    expect(code).toBe(4);
    expect(cap.err()).toContain('invariant broken');
  });

  it('maps an unexpected (non-Crucible) exception to exit 4 with a stack to stderr', async () => {
    const cap = captureIO();
    const boom = new Error('unexpected kaboom');
    const code = await runProgram(throwingProgram(boom), ['boom'], cap.io);
    expect(code).toBe(4);
    // Full stack trace, not just the message, lands on stderr.
    expect(cap.err()).toContain('unexpected kaboom');
    expect(cap.err()).toContain('at '); // a stack frame marker
    expect(cap.out()).toBe('');
  });

  it('unknown command → exit 2 with help and a hint', async () => {
    const cap = captureIO();
    const code = await runProgram(throwingProgram(undefined), ['no-such-cmd'], cap.io);
    expect(code).toBe(2);
    const err = cap.err();
    expect(err).toContain('no-such-cmd'); // names the offending token
    // Help surface: the available commands are listed.
    expect(err).toContain('boom');
    expect(err).toContain('ok');
    // A teaching hint pointing at --help.
    expect(err.toLowerCase()).toContain('--help');
  });

  it('--help exits 0 and prints help to stdout', async () => {
    const cap = captureIO();
    const code = await runProgram(throwingProgram(undefined), ['--help'], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain('boom');
  });
});

describe('runProgram --json plumbing', () => {
  it('emits a structured JSON error on stderr when --json precedes the command', async () => {
    const cap = captureIO();
    const code = await runProgram(
      throwingProgram(preconditionError('NO_APPROVAL', 'not approved', 'Run `crucible approve`.')),
      ['--json', 'boom'],
      cap.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.err().trim());
    expect(parsed).toEqual({
      error: {
        code: 'NO_APPROVAL',
        exit: 2,
        message: 'not approved',
        hint: 'Run `crucible approve`.',
      },
    });
  });
});
