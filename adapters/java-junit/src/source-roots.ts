// Query the build tool's evaluated model for configured Java test source roots.
// Grounding from a hard-coded convention would be a trust grant; these helpers
// ask Maven/Gradle for the roots they actually configured and fail closed when
// the model cannot be evaluated (design phase-3.md §2).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { WireError } from './wire.js';
import { findElements, parseXml, textOf, type XmlElement } from './xml.js';

const ROOT_PREFIX = 'CRUCIBLE_TEST_SOURCE_ROOT=';

export function mavenTestSourceRoots(cwd: string, mvnBin = 'mvn'): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-maven-model-'));
  const effectivePom = join(scratch, 'effective-pom.xml');
  try {
    const proc = spawnSync(
      mvnBin,
      ['-q', 'help:effective-pom', `-Doutput=${effectivePom}`, '-Dverbose=false'],
      { cwd, encoding: 'utf8' },
    );
    if (proc.error) throw new WireError(`could not spawn \`${mvnBin}\`: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new WireError(
        `\`mvn help:effective-pom\` failed (exit ${String(proc.status)}); cannot ground target files`,
      );
    }
    let root;
    try {
      root = parseXml(readFileSync(effectivePom, 'utf8'));
    } catch (error) {
      throw new WireError(`could not parse Maven's effective model: ${messageOf(error)}`);
    }

    // Effective Maven models carry the primary configured root here. Build-
    // helper's add-test-source inputs remain under <sources><source>; include
    // them too so non-conventional roots are not silently ignored.
    const roots = findElements(root, 'testSourceDirectory').map((el) => textOf(el).trim());
    for (const execution of findElements(root, 'execution')) {
      const goals = findElements(execution, 'goal').map((el) => textOf(el).trim());
      if (!goals.includes('add-test-source')) continue;
      roots.push(...findElements(execution, 'source').map((el) => textOf(el).trim()));
    }
    return normalizeRoots(cwd, roots);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Return Maven's evaluated test/main output directories in test-runtime order. */
export function mavenTestOutputDirectories(cwd: string, mvnBin = 'mvn'): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-maven-output-model-'));
  const effectivePom = join(scratch, 'effective-pom.xml');
  try {
    const proc = spawnSync(
      mvnBin,
      ['-q', 'help:effective-pom', `-Doutput=${effectivePom}`, '-Dverbose=false'],
      { cwd, encoding: 'utf8' },
    );
    if (proc.error) throw new WireError(`could not spawn \`${mvnBin}\`: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new WireError(
        `\`mvn help:effective-pom\` failed (exit ${String(proc.status)}); cannot derive test output directories`,
      );
    }
    let root: XmlElement;
    try {
      root = parseXml(readFileSync(effectivePom, 'utf8'));
    } catch (error) {
      throw new WireError(`could not parse Maven's effective model: ${messageOf(error)}`);
    }
    const build = directElements(root, 'build');
    if (build.length !== 1) {
      throw new WireError('Maven effective model must contain exactly one project build section');
    }
    return [
      resolve(cwd, requiredDirectText(build[0]!, 'testOutputDirectory')),
      resolve(cwd, requiredDirectText(build[0]!, 'outputDirectory')),
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function gradleTestSourceRoots(cwd: string, gradleBin = 'gradle'): string[] {
  const scratch = mkdtempSync(join(tmpdir(), 'crucible-gradle-model-'));
  const initScript = join(scratch, 'source-roots.gradle');
  writeFileSync(
    initScript,
    [
      'gradle.projectsEvaluated {',
      "  rootProject.tasks.register('cruciblePrintTestSourceRoots') {",
      '    doLast {',
      "      def sourceSets = rootProject.extensions.findByName('sourceSets')",
      "      if (sourceSets == null) throw new GradleException('Java sourceSets are unavailable')",
      "      sourceSets.getByName('test').allJava.srcDirs.collect { it.canonicalFile }",
      '        .sort { a, b -> a.path <=> b.path }',
      `        .each { println '${ROOT_PREFIX}' + it.path }`,
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  try {
    const proc = spawnSync(
      gradleBin,
      ['-q', '--console=plain', '--init-script', initScript, 'cruciblePrintTestSourceRoots'],
      { cwd, encoding: 'utf8' },
    );
    if (proc.error) throw new WireError(`could not spawn \`${gradleBin}\`: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new WireError(
        `\`gradle cruciblePrintTestSourceRoots\` failed (exit ${String(proc.status)}); cannot ground target files`,
      );
    }
    const roots = proc.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(ROOT_PREFIX))
      .map((line) => line.slice(ROOT_PREFIX.length));
    if (roots.length === 0) throw new WireError('Gradle reported no configured test source roots.');
    return normalizeRoots(cwd, roots);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizeRoots(cwd: string, roots: readonly string[]): string[] {
  return [
    ...new Set(roots.filter((root) => root.length > 0).map((root) => resolve(cwd, root))),
  ].sort();
}

function directElements(root: XmlElement, name: string): XmlElement[] {
  return root.children.filter(
    (child): child is XmlElement => child.type === 'element' && child.name === name,
  );
}

function requiredDirectText(root: XmlElement, name: string): string {
  const values = directElements(root, name).map((element) => textOf(element).trim());
  if (values.length !== 1 || values[0]!.length === 0) {
    throw new WireError(`Maven effective model must contain one non-empty <${name}>`);
  }
  return values[0]!;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
