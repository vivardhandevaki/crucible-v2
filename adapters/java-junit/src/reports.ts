// Shared report-join surface for both build-tool drivers (design phase-3.md §2,
// unified in P3-05). Maven's Surefire and Gradle's JUnit plugin write the same
// `TEST-*.xml` dialect — normalized by the shared `surefire.ts` reader — into
// different directories; everything downstream of "which directory" is identical:
// clear our own prior reports, read every report into a `className#methodName`
// map, and join each requested target back onto it in input order.
//
// Keeping this join in one place means a target present/absent/errored decision
// is made the same way regardless of build tool — the drivers differ only in how
// they invoke the tool and where its reports land, never in how a verdict is read
// (invariant 12: same reports → same normalized results).

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseSurefireReport, type SurefireCase } from './surefire.js';
import { splitTarget } from './wire.js';

/** A normalized `run` result (charter's normalized result schema, exactly). */
export interface RunResult {
  target: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  message?: string;
  location?: string;
  duration_ms?: number;
}

/** A normalized `resolve` result (found | missing; targetFile grounded in P3-06). */
export type ResolveResult =
  | {
      target: string;
      status: 'found';
      targetFile: string;
    }
  | {
      target: string;
      status: 'missing';
      candidateFile?: string;
    };

// Build output can be large; give spawnSync headroom over its 1MB default.
export const MAX_BUFFER = 64 * 1024 * 1024;
const LOG_TAIL_LINES = 40;

/** Remove our own prior `TEST-*.xml` from `dir` so "no reports after the run"
 *  reliably means a pre-test build failure, never a stale success artifact. */
export function clearReports(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.startsWith('TEST-') && file.endsWith('.xml')) rmSync(join(dir, file));
  }
}

/** Read every `TEST-*.xml` in `dir` into a `class#method` → case map (first wins). */
export function readReports(dir: string): Map<string, SurefireCase> {
  const map = new Map<string, SurefireCase>();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith('TEST-') || !file.endsWith('.xml')) continue;
    const xml = readFileSync(join(dir, file), 'utf8');
    for (const c of parseSurefireReport(xml)) {
      const key = `${c.className}#${c.methodName}`;
      if (!map.has(key)) map.set(key, c);
    }
  }
  return map;
}

/** Join one requested target onto the report map; an unreported target is `error`. */
export function toRunResult(target: string, cases: Map<string, SurefireCase>): RunResult {
  const { className, methodName } = splitTarget(target);
  const c = cases.get(`${className}#${methodName}`);
  if (c === undefined) {
    return {
      target,
      status: 'error',
      message: `no result reported for target: ${target} (test not found or not executed)`,
    };
  }
  return {
    target,
    status: c.status,
    ...(c.message !== undefined ? { message: c.message } : {}),
    ...(c.location !== undefined ? { location: c.location } : {}),
    ...(c.durationMs !== undefined ? { duration_ms: c.durationMs } : {}),
  };
}

/**
 * A build failure BEFORE any test ran (a compile error, or no test matched at
 * all): every requested target becomes `error` carrying the build-log tail —
 * fail-closed and attributable (design §2). `tool` names the build tool in the
 * message so the failure is traceable to what was spawned.
 */
export function buildFailureResults(
  targets: readonly string[],
  tool: string,
  exitStatus: number | null,
  stdout: string | undefined,
  stderr: string | undefined,
): RunResult[] {
  const tail = logTail(stdout, stderr);
  return targets.map((target) => ({
    target,
    status: 'error',
    message: `build failed before tests ran (${tool} exit ${String(exitStatus)}):\n${tail}`,
  }));
}

/** The last `LOG_TAIL_LINES` of combined stdout+stderr — enough to attribute a failure. */
export function logTail(stdout: string | undefined, stderr: string | undefined): string {
  const combined = `${stdout ?? ''}${stderr ?? ''}`.trimEnd();
  return combined.split('\n').slice(-LOG_TAIL_LINES).join('\n');
}
