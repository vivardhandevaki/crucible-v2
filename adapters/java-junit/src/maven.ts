// Maven build-tool driver (design phase-3.md §2 run/resolve paths). Spawns Maven
// in the project directory and normalizes what it produces:
//
//   run:     `mvn test -Dtest=<class#method...>` → parse Surefire XML → one
//            normalized result per requested target. A build failure BEFORE any
//            test runs (a compile error) yields ALL requested targets `error`
//            with the build-log tail as the message (fail-closed, attributable).
//   resolve: `mvn test-compile` to produce the classpath, then the bundled
//            Launcher-API helper (P3-03) classifies each target; the helper's
//            three-way vocabulary is folded to the wire's found | missing. The
//            targetFile grounding (design §2) lands in P3-06.
//
// The report-reading / target-join surface is shared with the Gradle driver
// (reports.ts); Maven differs only in how it invokes the tool and where Surefire
// writes. Determinism (invariant 12): the report is read from disk, not the
// flaky aggregate exit code; results are emitted in the caller's input order.

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
import { invokeResolve } from './resolve.js';
import { candidateTargetFile, groundTargetFile } from './source-file.js';
import { mavenTestSourceRoots } from './source-roots.js';
import { splitTarget, WireError } from './wire.js';

export type { ResolveResult, RunResult } from './reports.js';

export interface MavenRunOptions {
  /** The project directory (contains pom.xml). */
  cwd: string;
  /** Targets to run, `com.acme.FooTest#bar`, in wire order. */
  targets: string[];
  /** The `mvn` executable (default `"mvn"`). */
  mvnBin?: string;
}

/** Run `targets` via Maven Surefire and normalize the reports, in input order. */
export function runMaven(opts: MavenRunOptions): RunResult[] {
  if (opts.targets.length === 0) return [];
  const reportsDir = join(opts.cwd, 'target', 'surefire-reports');
  // Clear our own prior reports so "no reports after the run" reliably means a
  // pre-test build failure (compile error) rather than stale success artifacts.
  clearReports(reportsDir);

  const args = [
    '-q',
    '-DfailIfNoTests=false',
    '-Dsurefire.failIfNoSpecifiedTests=false',
    'test',
    `-Dtest=${buildSelector(opts.targets)}`,
  ];
  const proc = spawnSync(opts.mvnBin ?? 'mvn', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (proc.error) throw new WireError(`could not spawn \`mvn\`: ${proc.error.message}`);

  const cases = readReports(reportsDir);
  // Compile / build failure before Surefire ran: no reports AND a non-zero exit.
  // (No matching tests with a zero exit is NOT this case — those become per-target
  // `error` below, which is the honest "not found / not executed" outcome.)
  if (cases.size === 0 && proc.status !== 0) {
    return buildFailureResults(opts.targets, 'mvn', proc.status, proc.stdout, proc.stderr);
  }
  return opts.targets.map((target) => toRunResult(target, cases));
}

export interface MavenResolveOptions {
  cwd: string;
  targets: string[];
  /** Path to the bundled resolve-helper jar. */
  jarPath: string;
  mvnBin?: string;
  javaBin?: string;
}

/** Classify `targets` via the Launcher-API helper against a Maven-built classpath. */
export function resolveMaven(opts: MavenResolveOptions): ResolveResult[] {
  if (opts.targets.length === 0) return [];
  // Compile only (never `test`): resolve is discovery, it must not execute a test
  // body (the P3-03 canary guarantee). A compile failure is fail-closed: without
  // classes we cannot honestly classify, so we refuse rather than guess missing.
  const proc = spawnSync(opts.mvnBin ?? 'mvn', ['-q', 'test-compile'], {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (proc.error) throw new WireError(`could not spawn \`mvn\`: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new WireError(
      `\`mvn test-compile\` failed (exit ${String(proc.status)}); cannot resolve targets:\n${logTail(proc.stdout, proc.stderr)}`,
    );
  }

  const classpath = [join(opts.cwd, 'target', 'classes'), join(opts.cwd, 'target', 'test-classes')];
  const classified = invokeResolve({
    jarPath: opts.jarPath,
    classpath,
    targets: opts.targets,
    ...(opts.javaBin !== undefined ? { javaBin: opts.javaBin } : {}),
  });
  const sourceRoots = mavenTestSourceRoots(opts.cwd, opts.mvnBin);
  // Fold the helper's three-way classification to the frozen wire (design §2):
  // `unsupported` (parameterized / dynamic templates) → `missing`, which fails
  // closed at propose time per the addressable-subset rule (invariant 11).
  return classified.map((r) => {
    const className = r.className ?? splitTarget(r.target).className;
    if (r.classification === 'missing') {
      const candidateFile = candidateTargetFile({ root: opts.cwd, className, sourceRoots });
      return {
        target: r.target,
        status: 'missing' as const,
        ...(candidateFile ? { candidateFile } : {}),
      };
    }
    if (r.classification === 'unsupported') return { target: r.target, status: 'missing' as const };
    const targetFile = groundTargetFile({ root: opts.cwd, className, sourceRoots });
    if (targetFile === undefined)
      throw new WireError('resolved target cannot be grounded: ' + r.target);
    return { target: r.target, status: 'found' as const, targetFile };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Group targets by class into a Surefire `-Dtest` selector: `C#m1+m2,D#m3`. */
function buildSelector(targets: readonly string[]): string {
  const byClass = new Map<string, string[]>();
  for (const t of targets) {
    const { className, methodName } = splitTarget(t);
    const methods = byClass.get(className) ?? [];
    if (methodName.length > 0 && !methods.includes(methodName)) methods.push(methodName);
    byClass.set(className, methods);
  }
  return [...byClass.entries()]
    .map(([className, methods]) =>
      methods.length > 0 ? `${className}#${methods.join('+')}` : className,
    )
    .join(',');
}
