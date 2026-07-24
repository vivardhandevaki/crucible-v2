#!/usr/bin/env node
// Stub adapter executable — the wire-protocol entry point core (P1-11) spawns.
// See adapter.ts's header for the authoritative envelope. This shim only:
//   1. parses argv (verb + `--tests <path>`),
//   2. reads the full JSON request from stdin,
//   3. calls the pure adapter logic,
//   4. writes `{ results: [...] }` to stdout, or a stderr message + non-zero
//      exit on any fail-closed condition (invariant #3).

import { readFileSync } from 'node:fs';
import { parseInventory, parseRequest, resolve, run, WireError } from './adapter.js';

interface ParsedArgs {
  verb: 'resolve' | 'run';
  testsPath: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let verb: string | undefined;
  let testsPath = './tests.json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tests') {
      const next = argv[i + 1];
      if (next === undefined) throw new WireError('--tests requires a path argument');
      testsPath = next;
      i++;
    } else if (arg !== undefined && arg.startsWith('--tests=')) {
      testsPath = arg.slice('--tests='.length);
    } else if (arg === 'resolve' || arg === 'run') {
      if (verb !== undefined) throw new WireError(`unexpected extra verb: ${arg}`);
      verb = arg;
    } else {
      throw new WireError(`unknown argument: ${String(arg)}`);
    }
  }
  if (verb !== 'resolve' && verb !== 'run') {
    throw new WireError('missing verb: expected `resolve` or `run`');
  }
  return { verb, testsPath };
}

function readStdin(): string {
  // fd 0; synchronous full read. Empty stdin is itself invalid JSON → fail-closed.
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    throw new WireError(`could not read stdin: ${(err as Error).message}`);
  }
}

function main(): number {
  const { verb, testsPath } = parseArgs(process.argv.slice(2));

  let inventoryRaw: string;
  try {
    inventoryRaw = readFileSync(testsPath, 'utf8');
  } catch (err) {
    throw new WireError(`could not read tests file '${testsPath}': ${(err as Error).message}`);
  }
  const inventory = parseInventory(inventoryRaw, testsPath);
  const targets = parseRequest(readStdin());

  const results = verb === 'resolve' ? resolve(targets, inventory) : run(targets, inventory);
  process.stdout.write(JSON.stringify({ results }) + '\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crucible-adapter-stub: ${message}\n`);
  // Fail-closed: any wire/IO error is a non-zero exit, never a warning or a skip.
  process.exitCode = 1;
}
