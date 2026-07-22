#!/usr/bin/env node
// The executable shim: wire real process streams to the runner and translate
// its returned exit code into the process exit. All logic lives in program.ts /
// runner.ts so this file stays a trivial, untested adapter (architecture.md §1:
// cli/ parses args, prints, exits).

import { buildProgram } from './program.js';
import { runProgram, type RunnerIO } from './runner.js';

const io: RunnerIO = {
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
};

runProgram(buildProgram(), process.argv.slice(2), io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // The runner is contracted never to throw; if it somehow does, fail closed.
    process.stderr.write((err instanceof Error ? (err.stack ?? err.message) : String(err)) + '\n');
    process.exitCode = 4;
  });
