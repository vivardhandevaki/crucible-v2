// P4R-09 — build-tool-evaluated test classpaths for Launcher discovery. These
// queries may resolve/compile dependencies but never invoke a project's test
// task or goal. Any failure is a wire error: discovery must never degrade a
// broken judge into a `missing` target.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { WireError } from './wire.js';

const MAVEN_DEPENDENCY_PLUGIN =
  'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath';
const GRADLE_TASK = 'cruciblePrintTestClasspath';
const GRADLE_OUTPUT_PROPERTY = 'crucible.test.classpath.output';
const MAX_BUFFER = 10 * 1024 * 1024;

export interface MavenDependencyClasspathOptions {
  cwd: string;
  mvnBin?: string;
}

export interface GradleTestClasspathOptions {
  cwd: string;
  gradleBin?: string;
}

/** Parse ordered Maven Dependency Plugin output; empty output means no dependencies. */
export function parseMavenDependencyClasspath(raw: string, separator = delimiter): string[] {
  if (separator.length === 0) throw new WireError('classpath separator must not be empty');
  if (raw.trim().length === 0) return [];
  return dedupeEntries(raw.replace(/(?:\r?\n)+$/, '').split(separator), 'Maven');
}

/** Parse the Gradle model query response strictly; no build-log fallback exists. */
export function parseGradleTestClasspath(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WireError(`Gradle test classpath output is not JSON: ${messageOf(error)}`);
  }
  if (!Array.isArray(parsed))
    throw new WireError('Gradle test classpath output must be a JSON array');
  if (!parsed.every((entry) => typeof entry === 'string')) {
    throw new WireError('Gradle test classpath entries must be strings');
  }
  return dedupeEntries(parsed, 'Gradle');
}

/** Preserve test-output, main-output, then dependency order, dropping only later duplicates. */
export function assembleTestClasspath(
  outputDirectories: readonly string[],
  dependencies: readonly string[],
): string[] {
  return dedupeEntries([...outputDirectories, ...dependencies], 'test');
}

/** Ask Maven for its resolved test-scope dependency classpath. */
export function mavenDependencyClasspath(opts: MavenDependencyClasspathOptions): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-maven-classpath-'));
  const output = join(scratch, 'classpath.txt');
  const mvnBin = opts.mvnBin ?? 'mvn';
  try {
    const proc = spawnSync(
      mvnBin,
      ['-q', MAVEN_DEPENDENCY_PLUGIN, '-DincludeScope=test', `-Dmdep.outputFile=${output}`],
      { cwd: opts.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
    );
    if (proc.error) throw new WireError(`could not spawn \`${mvnBin}\`: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new WireError(
        `\`${mvnBin} ${MAVEN_DEPENDENCY_PLUGIN}\` failed (exit ${String(proc.status)}); cannot resolve test classpath:\n${tail(proc.stdout, proc.stderr)}`,
      );
    }
    if (!existsSync(output)) {
      throw new WireError('Maven did not write its requested test classpath output file');
    }
    const entries = parseMavenDependencyClasspath(readFileSync(output, 'utf8'));
    for (const entry of entries) {
      if (!existsSync(entry)) {
        throw new WireError(`Maven reported a test dependency that does not exist: ${entry}`);
      }
    }
    return entries;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Query the evaluated root Gradle `test` task classpath without invoking that task. */
export function gradleTestClasspath(opts: GradleTestClasspathOptions): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-gradle-classpath-'));
  const initScript = join(scratch, 'test-classpath.gradle');
  const output = join(scratch, 'classpath.json');
  const gradleBin = opts.gradleBin ?? 'gradle';
  writeFileSync(initScript, gradleClasspathScript(), 'utf8');
  try {
    const proc = spawnSync(
      gradleBin,
      [
        '-q',
        '--console=plain',
        '--init-script',
        initScript,
        `-D${GRADLE_OUTPUT_PROPERTY}=${output}`,
        GRADLE_TASK,
      ],
      { cwd: opts.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
    );
    if (proc.error) throw new WireError(`could not spawn \`${gradleBin}\`: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new WireError(
        `\`${gradleBin} ${GRADLE_TASK}\` failed (exit ${String(proc.status)}); cannot resolve test classpath:\n${tail(proc.stdout, proc.stderr)}`,
      );
    }
    if (!existsSync(output)) {
      throw new WireError('Gradle did not write its requested test classpath output file');
    }
    return parseGradleTestClasspath(readFileSync(output, 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function dedupeEntries(entries: readonly string[], tool: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.trim().length === 0)
      throw new WireError(`${tool} test classpath entries must be non-empty`);
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function gradleClasspathScript(): string {
  return [
    'gradle.projectsEvaluated {',
    `  def outputPath = System.getProperty('${GRADLE_OUTPUT_PROPERTY}')`,
    "  if (outputPath == null || outputPath.trim().isEmpty()) throw new GradleException('missing Crucible classpath output path')",
    `  rootProject.tasks.register('${GRADLE_TASK}') {`,
    '    doLast {',
    "      def testTask = rootProject.tasks.findByName('test')",
    "      if (!(testTask instanceof org.gradle.api.tasks.testing.Test)) throw new GradleException('root test task is missing or is not a Test task')",
    '      def entries = testTask.classpath.files.collect { it.canonicalFile.path }',
    '      new File(outputPath).text = groovy.json.JsonOutput.toJson(entries)',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

function tail(stdout: string | null, stderr: string | null): string {
  return `${stdout ?? ''}\n${stderr ?? ''}`.trim().slice(-4000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
