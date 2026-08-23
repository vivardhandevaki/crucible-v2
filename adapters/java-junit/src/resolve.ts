// java-junit resolve — wrapper invocation over the bundled helper jar (task
// P3-03, design phase-3.md §2).
//
// The Java helper (com.crucible.junit.ResolveHelper) does the discovery-only
// classification; this module is the thin TypeScript seam that spawns it and
// fail-closed-validates its JSON. It is deliberately narrow: it takes an
// explicit classpath and returns the helper's own three-way vocabulary
// (found | missing | unsupported). The full adapter CLI (P3-04) grows from
// here — it will speak the stdin/stdout wire and fold `unsupported` → `missing`
// for the frozen resolve envelope (architecture.md §7); this seam does not, so
// the three-way truth stays inspectable in tests.

import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

/** The helper's three-way classification (design §2, pre-wire). */
export type ResolveClassification = 'found' | 'missing' | 'unsupported';

const CLASSIFICATIONS = new Set<ResolveClassification>(['found', 'missing', 'unsupported']);

/** One classified target as emitted by the helper. */
export interface ResolveHelperResult {
  target: string;
  classification: ResolveClassification;
  /** The engine's view of the class, when the target resolved to one. */
  className?: string;
  /** The engine's view of the method, when the target resolved to one. */
  methodName?: string;
}

export interface InvokeResolveOptions {
  /** Path to the shaded resolve-helper jar. */
  jarPath: string;
  /** The project-under-test's compiled classpath entries (main + test classes). */
  classpath: string[];
  /** Adapter target strings to classify (`com.acme.FooTest#bar`). */
  targets: string[];
  /** Extra `-Dkey=value` JVM system properties (e.g. the canary dir). */
  systemProperties?: Record<string, string>;
  /** The `java` executable to spawn (default `"java"`). */
  javaBin?: string;
}

/** Thrown on any fail-closed condition: spawn failure, non-zero exit, or bad JSON. */
export class ResolveInvocationError extends Error {
  override readonly name = 'ResolveInvocationError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(value: unknown, index: number): ResolveHelperResult {
  if (!isRecord(value)) {
    throw new ResolveInvocationError(`result ${index} is not an object`);
  }
  const { target, classification, className, methodName } = value;
  if (typeof target !== 'string' || target.length === 0) {
    throw new ResolveInvocationError(`result ${index} has no string \`target\``);
  }
  if (
    typeof classification !== 'string' ||
    !CLASSIFICATIONS.has(classification as ResolveClassification)
  ) {
    throw new ResolveInvocationError(
      `result ${index} (${target}) has invalid \`classification\`: ${JSON.stringify(classification)}`,
    );
  }
  if (className !== undefined && typeof className !== 'string') {
    throw new ResolveInvocationError(`result ${index} (${target}) has non-string \`className\``);
  }
  if (methodName !== undefined && typeof methodName !== 'string') {
    throw new ResolveInvocationError(`result ${index} (${target}) has non-string \`methodName\``);
  }
  return {
    target,
    classification: classification as ResolveClassification,
    ...(typeof className === 'string' ? { className } : {}),
    ...(typeof methodName === 'string' ? { methodName } : {}),
  };
}

/**
 * Spawn the helper jar to classify `targets` against `classpath`, returning one
 * result per target in input order. Fail-closed: a spawn failure, a non-zero
 * exit, non-JSON stdout, or a schema violation all throw — a resolve that
 * cannot speak is never treated as an empty/clean result.
 */
export function invokeResolve(opts: InvokeResolveOptions): ResolveHelperResult[] {
  const javaBin = opts.javaBin ?? 'java';
  const cp = [opts.jarPath, ...opts.classpath].join(delimiter);
  const sysProps = Object.entries(opts.systemProperties ?? {}).map(([k, v]) => `-D${k}=${v}`);
  const args = [...sysProps, '-cp', cp, 'com.crucible.junit.ResolveHelper', ...opts.targets];

  const proc = spawnSync(javaBin, args, { encoding: 'utf8' });
  if (proc.error) {
    throw new ResolveInvocationError(`could not spawn \`${javaBin}\`: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new ResolveInvocationError(
      `resolve helper exited ${String(proc.status)}: ${proc.stderr?.trim() ?? ''}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (e) {
    throw new ResolveInvocationError(
      `resolve helper stdout is not JSON: ${(e as Error).message}\n${proc.stdout}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new ResolveInvocationError(
      'resolve helper output must be an object with a `results` array',
    );
  }
  const results = parsed.results.map(parseResult);
  if (results.length !== opts.targets.length) {
    throw new ResolveInvocationError(
      `resolve helper returned ${results.length} results for ${opts.targets.length} targets`,
    );
  }
  return results;
}
