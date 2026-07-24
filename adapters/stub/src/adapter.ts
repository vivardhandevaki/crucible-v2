// Stub adapter — the wire-protocol logic, factored out of the CLI shim so it is
// unit-testable in-process. The executable surface (`cli.ts`) is what the core
// adapter client (P1-11) spawns and what the conformance tests drive; this file
// holds only pure, deterministic mapping over a loaded `tests.json` inventory.
//
// ─── Wire protocol (authoritative; P1-11 conforms to this) ───────────────────
// Verb selection: argv[0] is the verb, `resolve` or `run`.
// Config:         `--tests <path>` (default `./tests.json`) names the inventory.
// Request body:   JSON on stdin — `{ "targets": string[] }`.
// Response:        JSON on stdout — `{ "results": [...] }`, one entry per target,
//                 in input order.
//   resolve → { target, status: "found"|"missing", targetFile? }
//             (targetFile present iff found)
//   run     → { target, status: "pass"|"fail"|"error"|"skip",
//               message?, location?, duration_ms? }   (charter schema exactly)
// Fail-closed:    invalid JSON, a non-`{targets:[...]}` body, or a missing/unknown
//                 verb → the CLI exits non-zero with a stderr message. This module
//                 throws `WireError` for those; the shim translates to an exit.
//
// ─── Inventory → result mapping (design phase-0-1.md §7) ─────────────────────
// resolve: a target matching a row `id` → found, targetFile = row.file. An
//   unknown target, OR a row whose status is `"missing"` (uncollectible), →
//   missing. Both "no such id" and "declared missing" collapse to missing so
//   the linter sees one uncollectible signal.
// run: pass/fail/skip pass through verbatim (carrying `message` where present).
//   `skip` is NOT mapped to fail here — that is core's job downstream
//   (charter: "skip maps to fail for oracle targets"). A row with status
//   `"missing"`, or a target with no row at all, → `error` (fail-closed: a judge
//   that cannot be found/collected is never silently dropped).

/** One row of the stub's declarative inventory (`tests.json`). */
export interface StubTestEntry {
  id: string;
  file: string;
  status: 'pass' | 'fail' | 'skip' | 'missing';
  message?: string;
}

export interface ResolveResult {
  target: string;
  status: 'found' | 'missing';
  targetFile?: string;
}

export interface RunResult {
  target: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  message?: string;
  location?: string;
  duration_ms?: number;
}

/** Thrown on any fail-closed condition; the CLI shim turns it into a non-zero exit. */
export class WireError extends Error {
  override readonly name = 'WireError';
}

const TEST_STATUSES = new Set(['pass', 'fail', 'skip', 'missing']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse + fail-closed validate a raw `tests.json` string into the inventory. */
export function parseInventory(raw: string, source: string): StubTestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WireError(`${source}: not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new WireError(`${source}: tests.json must be a JSON array`);
  }
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new WireError(`${source}: entry ${index} is not an object`);
    }
    const { id, file, status, message } = entry;
    if (typeof id !== 'string' || id.length === 0) {
      throw new WireError(`${source}: entry ${index} has no string \`id\``);
    }
    if (typeof file !== 'string' || file.length === 0) {
      throw new WireError(`${source}: entry ${index} (${id}) has no string \`file\``);
    }
    if (typeof status !== 'string' || !TEST_STATUSES.has(status)) {
      throw new WireError(
        `${source}: entry ${index} (${id}) has invalid \`status\`: ${JSON.stringify(status)}`,
      );
    }
    if (message !== undefined && typeof message !== 'string') {
      throw new WireError(`${source}: entry ${index} (${id}) has non-string \`message\``);
    }
    return {
      id,
      file,
      status: status as StubTestEntry['status'],
      ...(typeof message === 'string' ? { message } : {}),
    };
  });
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

function indexBy(inventory: readonly StubTestEntry[]): Map<string, StubTestEntry> {
  const byId = new Map<string, StubTestEntry>();
  for (const entry of inventory) {
    // First row wins for a duplicate id; deterministic on input order.
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return byId;
}

/** resolve: map each target to found (+targetFile) or missing, in input order. */
export function resolve(
  targets: readonly string[],
  inventory: readonly StubTestEntry[],
): ResolveResult[] {
  const byId = indexBy(inventory);
  return targets.map((target) => {
    const row = byId.get(target);
    if (row === undefined || row.status === 'missing') {
      return { target, status: 'missing' };
    }
    return { target, status: 'found', targetFile: row.file };
  });
}

/** run: map each target to a normalized result, in input order. */
export function run(targets: readonly string[], inventory: readonly StubTestEntry[]): RunResult[] {
  const byId = indexBy(inventory);
  return targets.map((target): RunResult => {
    const row = byId.get(target);
    if (row === undefined) {
      return { target, status: 'error', message: `no test found for target: ${target}` };
    }
    if (row.status === 'missing') {
      return {
        target,
        status: 'error',
        message: `test is uncollectible (missing): ${target}`,
      };
    }
    // pass / fail / skip pass through verbatim. skip is NOT mapped to fail here.
    return {
      target,
      status: row.status,
      ...(row.message !== undefined ? { message: row.message } : {}),
    };
  });
}
