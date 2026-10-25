// Gradle build-tool driver (design phase-3.md §2 run/resolve paths). The Gradle
// twin of maven.ts — same normalized verdicts, same fail-closed posture; only
// the invocation and report location differ:
//
//   run:     `gradle test --rerun-tasks --tests <Class.method>...` → parse the
//            JUnit XML Gradle writes under `build/test-results/test/` → one
//            normalized result per requested target. `--rerun-tasks` defeats
//            Gradle's up-to-date cache so the XML is always fresh (invariant 12);
//            without it a cached task writes nothing and we would read stale or
//            no reports. A build failure BEFORE any test runs (a compile error,
//            or no `--tests` filter matched any test) yields ALL requested
//            targets `error` with the build-log tail (fail-closed, attributable).
//   resolve: `gradle testClasses` to compile, then the evaluated root `test`
//            task classpath feeds the bundled Launcher-API helper, which
//            classifies each target;
//            the three-way vocabulary folds to the wire's found | missing.
//
// The report-reading / target-join surface is shared with the Maven driver
// (reports.ts): both dialects normalize through the same reader, so a target's
// pass/fail/skip/error is decided identically regardless of build tool.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  buildFailureResults,
  clearReports,
  logTail,
  MAX_BUFFER,
  readReports,
  toRunResult,
  type ResolveResult,
  type RunResult,
} from './reports.js';
import { gradleTestClasspath } from './test-classpath.js';
import { invokeResolve } from './resolve.js';
import { groundTargetFile } from './source-file.js';
import { gradleTestSourceRoots } from './source-roots.js';
import { splitTarget, WireError } from './wire.js';

export interface GradleRunOptions {
  /** The project directory (contains build.gradle(.kts)). */
  cwd: string;
  /** Targets to run, `com.acme.FooTest#bar`, in wire order. */
  targets: string[];
  /** The `gradle` executable (default `"gradle"`). */
  gradleBin?: string;
}

/** Run `targets` via Gradle and normalize the JUnit reports, in input order. */
export function runGradle(opts: GradleRunOptions): RunResult[] {
  if (opts.targets.length === 0) return [];
  const reportsDir = join(opts.cwd, 'build', 'test-results', 'test');
  // Clear our own prior reports so "no reports after the run" reliably means a
  // pre-test build failure rather than stale success artifacts. `--rerun-tasks`
  // below forces a fresh execution regardless of Gradle's task cache.
  clearReports(reportsDir);

  const args = ['test', '--rerun-tasks', '-q', '--console=plain', ...buildTestArgs(opts.targets)];
  const proc = spawnSync(opts.gradleBin ?? 'gradle', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (proc.error) throw new WireError(`could not spawn \`gradle\`: ${proc.error.message}`);

  const cases = readReports(reportsDir);
  // No reports AND a non-zero exit: either a compile error before the test task,
  // or every `--tests` filter matched nothing (Gradle fails the task with "No
  // tests found for given includes"). Both are fail-closed: all targets `error`.
  // (A mix where SOME filter matches runs those and leaves the unmatched ones
  // unreported → per-target `error` below — the honest "not found" outcome.)
  if (cases.size === 0 && proc.status !== 0) {
    return buildFailureResults(opts.targets, 'gradle', proc.status, proc.stdout, proc.stderr);
  }
  return opts.targets.map((target) => toRunResult(target, cases));
}

export interface GradleResolveOptions {
  cwd: string;
  targets: string[];
  /** Path to the bundled resolve-helper jar. */
  jarPath: string;
  gradleBin?: string;
  javaBin?: string;
}

/** Classify `targets` via the Launcher-API helper against a Gradle-built classpath. */
export function resolveGradle(opts: GradleResolveOptions): ResolveResult[] {
  if (opts.targets.length === 0) return [];
  // Compile only (`testClasses`, never `test`): resolve is discovery, it must not
  // execute a test body (the P3-03 canary guarantee). A compile failure is fail-
  // closed: without classes we cannot honestly classify, so we refuse.
  const proc = spawnSync(opts.gradleBin ?? 'gradle', ['testClasses', '-q', '--console=plain'], {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (proc.error) throw new WireError(`could not spawn \`gradle\`: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new WireError(
      `\`gradle testClasses\` failed (exit ${String(proc.status)}); cannot resolve targets:\n${logTail(proc.stdout, proc.stderr)}`,
    );
  }

  const classpath = gradleTestClasspath({
    cwd: opts.cwd,
    ...(opts.gradleBin ? { gradleBin: opts.gradleBin } : {}),
  });
  const classified = invokeResolve({
    jarPath: opts.jarPath,
    classpath,
    targets: opts.targets,
    ...(opts.javaBin !== undefined ? { javaBin: opts.javaBin } : {}),
  });
  const sourceRoots = gradleTestSourceRoots(opts.cwd, opts.gradleBin);
  // Fold the helper's three-way classification to the frozen wire (design §2):
  // `unsupported` (parameterized / dynamic templates) → `missing`, which fails
  // closed at propose time per the addressable-subset rule (invariant 11).
  return classified.map((r) => {
    if (r.classification !== 'found') return { target: r.target, status: 'missing' };
    const className = r.className ?? splitTarget(r.target).className;
    const targetFile = groundTargetFile({ root: opts.cwd, className, sourceRoots });
    if (targetFile === undefined) {
      throw new WireError(`resolved target cannot be grounded: ${r.target}`);
    }
    return { target: r.target, status: 'found', targetFile };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build Gradle's test filter: one `--tests <Class.method>` per unique target
 * (Gradle has no `+`-grouping analogue to Surefire's `-Dtest`). A target naming
 * no method filters the whole class. Unmatched filters are ignored by Gradle as
 * long as at least one matches — mirroring Maven's `failIfNoTests=false`.
 */
function buildTestArgs(targets: readonly string[]): string[] {
  const patterns: string[] = [];
  for (const t of targets) {
    const { className, methodName } = splitTarget(t);
    const pattern = methodName.length > 0 ? `${className}.${methodName}` : className;
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns.flatMap((p) => ['--tests', p]);
}
