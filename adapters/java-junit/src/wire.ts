// Shared wire helpers for the java-junit adapter CLI. Kept apart from the build-
// tool drivers so the fail-closed request parsing (invariant 3) is one small,
// testable surface both `resolve` and `run` go through.

/** Thrown on any fail-closed condition; the CLI shim turns it into a non-zero exit. */
export class WireError extends Error {
  override readonly name = 'WireError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse + fail-closed validate the stdin request body into a target list. */
export function parseRequest(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WireError(`stdin is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.targets)) {
    throw new WireError('stdin must be an object with a `targets` array');
  }
  if (!parsed.targets.every((t) => typeof t === 'string')) {
    throw new WireError('every entry in `targets` must be a string');
  }
  return parsed.targets;
}

/** A target split into its class + method halves (`com.acme.FooTest#bar`). */
export interface SplitTarget {
  className: string;
  /** The method name, or '' when the target names no method (not addressable). */
  methodName: string;
}

/** Split an adapter target string on its first `#` (the class/method boundary). */
export function splitTarget(target: string): SplitTarget {
  const hash = target.indexOf('#');
  if (hash < 0) return { className: target, methodName: '' };
  return { className: target.slice(0, hash), methodName: target.slice(hash + 1) };
}
