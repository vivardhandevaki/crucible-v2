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
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect, detectBuildTool, type BuildTool, type DetectDeps } from './detect.js';
import {
  CRUCIBLE_EMBEDDED_HELPER_JAR,
  CRUCIBLE_EMBEDDED_HELPER_SHA256,
} from './embedded-helper.js';
import { runGradle, resolveGradle } from './gradle.js';
import { runMaven, resolveMaven } from './maven.js';
import { parseRequest, WireError } from './wire.js';

type Verb = 'detect' | 'resolve' | 'run';

const HERE = dirname(fileURLToPath(import.meta.url));

interface MaterializedHelper {
  path: string;
  cleanup(): void;
}

/**
 * Development builds use the adjacent jar. The P3-06 package embeds those same
 * bytes and materializes a private, per-process copy only for the Java classpath.
 */
function materializeHelperJar(): MaterializedHelper {
  const override = process.env['CRUCIBLE_JAVA_JUNIT_JAR'];
  if (override !== undefined && override.length > 0) return { path: override, cleanup() {} };
  if (CRUCIBLE_EMBEDDED_HELPER_JAR.length === 0) {
    return {
      path: join(HERE, '..', 'resolve-helper', 'target', 'resolve-helper.jar'),
      cleanup() {},
    };
  }

  const bytes = Buffer.from(CRUCIBLE_EMBEDDED_HELPER_JAR, 'base64');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== CRUCIBLE_EMBEDDED_HELPER_SHA256) {
    throw new WireError('embedded resolve-helper jar failed its sha256 self-check');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-java-junit-'));
  const path = join(scratch, 'resolve-helper.jar');
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    path,
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
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
  const buildTool = resolveBuildTool(cwd);
  const results =
    buildTool === 'maven' ? runOnMaven(verb, cwd, targets) : runOnGradle(verb, cwd, targets);
  process.stdout.write(JSON.stringify({ results }) + '\n');
  return 0;
}

/** Pick the build tool for the resolve/run wire, fail-closed if neither is present. */
function resolveBuildTool(cwd: string): BuildTool {
  const buildTool = detectBuildTool((name) => existsSync(join(cwd, name)));
  if (buildTool === undefined) {
    throw new WireError(
      'no pom.xml or build.gradle(.kts) found in the working directory — nothing to drive',
    );
  }
  return buildTool;
}

function runOnMaven(verb: 'resolve' | 'run', cwd: string, targets: string[]) {
  if (verb === 'run') return runMaven({ cwd, targets });
  const helper = materializeHelperJar();
  try {
    return resolveMaven({ cwd, targets, jarPath: helper.path });
  } finally {
    helper.cleanup();
  }
}

function runOnGradle(verb: 'resolve' | 'run', cwd: string, targets: string[]) {
  if (verb === 'run') return runGradle({ cwd, targets });
  const helper = materializeHelperJar();
  try {
    return resolveGradle({ cwd, targets, jarPath: helper.path });
  } finally {
    helper.cleanup();
  }
}

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crucible-adapter-java-junit: ${message}\n`);
  // Fail-closed: any wire/IO/spawn error is a non-zero exit, never a skip.
  process.exitCode = 1;
}
