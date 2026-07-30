#!/usr/bin/env node
// java-junit adapter executable — the wire-protocol entry point core (P1-11)
// spawns, and what the conformance runner drives. Verbs:
//   detect            → JSON verdict on stdout; reads no stdin (init calls it).
//   resolve | run     → read `{ "targets": [...] }` on stdin, write
//                       `{ "results": [...] }` on stdout.
// Fail-closed (invariant 3): any bad argv, unreadable stdin, spawn failure, or
// unparseable report throws → a stderr message and a non-zero exit, never a
// warning or a silent green. The adapter auto-detects the build tool from the
// working directory core sets (the project under test).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect, type DetectDeps } from './detect.js';
import { runMaven, resolveMaven } from './maven.js';
import { parseRequest, WireError } from './wire.js';

type Verb = 'detect' | 'resolve' | 'run';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundled resolve-helper jar (P3-03). Overridable for packaging/tests. */
function helperJarPath(): string {
  const override = process.env['CRUCIBLE_JAVA_JUNIT_JAR'];
  if (override !== undefined && override.length > 0) return override;
  // dist/cli.js → package root → resolve-helper/target/resolve-helper.jar.
  return join(HERE, '..', 'resolve-helper', 'target', 'resolve-helper.jar');
}

function parseVerb(argv: readonly string[]): Verb {
  const verb = argv[0];
  if (verb === 'detect' || verb === 'resolve' || verb === 'run') {
    if (argv.length > 1) throw new WireError(`unexpected extra argument: ${String(argv[1])}`);
    return verb;
  }
  throw new WireError(`missing or unknown verb: expected \`detect\`, \`resolve\`, or \`run\``);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    throw new WireError(`could not read stdin: ${(err as Error).message}`);
  }
}

/** Real environment probes for detect (fs existence + a `java -version` check). */
function detectDeps(cwd: string): DetectDeps {
  return {
    fileExists: (name) => existsSync(join(cwd, name)),
    hasJdk: () => spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0,
  };
}

function main(): number {
  const verb = parseVerb(process.argv.slice(2));
  const cwd = process.cwd();

  if (verb === 'detect') {
    process.stdout.write(JSON.stringify(detect(detectDeps(cwd))) + '\n');
    return 0;
  }

  const targets = parseRequest(readStdin());
  const results =
    verb === 'resolve'
      ? resolveMaven({ cwd, targets, jarPath: helperJarPath() })
      : runMaven({ cwd, targets });
  process.stdout.write(JSON.stringify({ results }) + '\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crucible-adapter-java-junit: ${message}\n`);
  // Fail-closed: any wire/IO/spawn error is a non-zero exit, never a skip.
  process.exitCode = 1;
}
