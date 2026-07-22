// Error taxonomy — the spine of every exit-code decision (architecture.md §3).
//
// Everything thrown from below `commands/` is a `CrucibleError` carrying the
// exit code it maps to plus a teaching `hint` ("run X"). The shared runner
// (runner.ts) is the only place these become process exit codes. Bare
// strings/Errors below `commands/` are a bug (invariant: fail-closed).

/** The non-success exit codes a CrucibleError may carry (architecture.md §2). */
export type ExitCode = 2 | 3 | 4;

export interface CrucibleErrorOptions {
  /** Stable machine identifier, e.g. `NO_APPROVAL`. Surfaced in `--json`. */
  code: string;
  /** Process exit code this error maps to. */
  exit: ExitCode;
  /** The teaching line: what the user should run/fix next. May be empty. */
  hint: string;
  /** Underlying error, preserved for diagnostics. */
  cause?: unknown;
}

export class CrucibleError extends Error {
  readonly code: string;
  readonly exit: ExitCode;
  readonly hint: string;

  constructor(message: string, options: CrucibleErrorOptions) {
    // Only pass `cause` through when present — exactOptionalPropertyTypes is on.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CrucibleError';
    this.code = options.code;
    this.exit = options.exit;
    this.hint = options.hint;
  }
}

export function isCrucibleError(value: unknown): value is CrucibleError {
  return value instanceof CrucibleError;
}

/**
 * Exit 2 — a precondition is unmet. The `hint` must name the exact next
 * command to run (architecture.md §2: exit 2 messages are teaching surfaces).
 */
export function preconditionError(code: string, message: string, hint: string): CrucibleError {
  return new CrucibleError(message, { code, exit: 2, hint });
}

/**
 * Exit 3 — invalid config, schema, or artifact. Any parse/validation
 * uncertainty maps here, never to a warning (fail-closed, architecture.md §3).
 */
export function invalidInputError(code: string, message: string, hint: string): CrucibleError {
  return new CrucibleError(message, { code, exit: 3, hint });
}

/**
 * Exit 4 — an internal error / broken invariant in Crucible itself. Distinct
 * from an unexpected native exception (also exit 4) in that it is deliberate
 * and carries a code + hint rather than a raw stack.
 */
export function internalError(code: string, message: string, hint: string): CrucibleError {
  return new CrucibleError(message, { code, exit: 4, hint });
}
