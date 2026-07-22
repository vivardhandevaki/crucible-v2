// Shared CLI runner — the one place thrown errors become process exit codes
// (architecture.md §2–3). The cli/ layer parses args, prints, and exits; it
// holds no domain logic. Command modules orchestrate and throw CrucibleError;
// this runner maps those (and commander's own parse errors, and unexpected
// native exceptions) onto the exit-code table.

import { CommanderError } from 'commander';
import type { Command } from 'commander';
import { CrucibleError, isCrucibleError, preconditionError } from './errors.js';

/** Injectable output sink so the runner never touches process streams directly. */
export interface RunnerIO {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/**
 * Parse and dispatch `argv` (user args, without node/script) through the given
 * commander program, returning the process exit code. Never calls
 * `process.exit`: the caller (bin.ts) owns that so the runner stays testable.
 */
export async function runProgram(program: Command, argv: string[], io: RunnerIO): Promise<number> {
  // Commander must throw instead of exiting the process, and all of its output
  // routes through our sink. We suppress commander's own stderr writes because
  // this runner emits every error line deterministically below.
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => io.writeOut(s),
    writeErr: () => {},
  });

  // `--json` may appear before parsing completes (or fail to parse at all), so
  // detect it from the raw argv for the error-formatting path.
  const json = argv.includes('--json');

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    return handleError(err, io, json, program);
  }
}

function handleError(err: unknown, io: RunnerIO, json: boolean, program: Command): number {
  if (err instanceof CommanderError) {
    return handleCommanderError(err, io, json, program);
  }
  if (isCrucibleError(err)) {
    emitError(err, io, json);
    return err.exit;
  }
  return emitUnexpected(err, io, json);
}

function handleCommanderError(
  err: CommanderError,
  io: RunnerIO,
  json: boolean,
  program: Command,
): number {
  // --help / --version and other clean displays exit 0; commander already
  // wrote their content to stdout via configureOutput.
  if (err.exitCode === 0) {
    return 0;
  }

  if (err.code === 'commander.unknownCommand') {
    // Print the full help surface, then the teaching error (architecture.md §2:
    // exit 2 names the fix). helpInformation() lists the available commands.
    if (!json) {
      io.writeErr(program.helpInformation());
    }
    const mapped = preconditionError(
      'UNKNOWN_COMMAND',
      stripErrorPrefix(err.message),
      `Run \`${program.name()} --help\` to see available commands.`,
    );
    emitError(mapped, io, json);
    return mapped.exit;
  }

  // Other usage failures (unknown option, missing/excess argument, …) are
  // precondition-style: the invocation is wrong. Map them to exit 2 with a
  // pointer to --help rather than leaking commander's default exit 1.
  const mapped = preconditionError(
    'USAGE',
    stripErrorPrefix(err.message),
    `Run \`${program.name()} --help\` for usage.`,
  );
  emitError(mapped, io, json);
  return mapped.exit;
}

/** Exit 4 — an exception we did not model. Always dump the stack to stderr. */
function emitUnexpected(err: unknown, io: RunnerIO, json: boolean): number {
  const error = err instanceof Error ? err : new Error(String(err));
  if (json) {
    io.writeErr(
      JSON.stringify({
        error: { code: 'INTERNAL', exit: 4, message: error.message },
      }) + '\n',
    );
  }
  io.writeErr((error.stack ?? error.message) + '\n');
  return 4;
}

function emitError(err: CrucibleError, io: RunnerIO, json: boolean): void {
  if (json) {
    io.writeErr(
      JSON.stringify({
        error: { code: err.code, exit: err.exit, message: err.message, hint: err.hint },
      }) + '\n',
    );
    return;
  }
  io.writeErr(`error: ${err.message}\n`);
  if (err.hint) {
    io.writeErr(`hint: ${err.hint}\n`);
  }
}

function stripErrorPrefix(message: string): string {
  return message.replace(/^error:\s*/i, '');
}
