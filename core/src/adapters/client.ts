// Adapter client — the ONLY module that spawns an adapter process (architecture
// .md §1: "nothing outside `adapters` spawns an adapter process"). It loads the
// manifest, tokenizes the invocation string for a verb, spawns the adapter as a
// subprocess speaking JSON over stdin/stdout, zod-validates every response, and
// joins run results back to oracle IDs (ORC join) with skip→fail coercion.
//
// TCB (charter §Adapters Are Part of the TCB): an adapter decides whether checks
// pass, so this client is exactly as security-critical as the harness. Every
// transport failure is fail-closed at exit 3 (invariant 3, task P1-11 acceptance):
//   - non-zero adapter exit        → a judge that crashed cannot report green
//   - timeout                       → a judge that hung cannot report green
//   - garbage / schema-violating JSON → an unparseable verdict is never a pass
//   - a dropped target (fewer results than requested) → a vanished judge fails
// Determinism (invariant 12): results are joined back in oracle input order and
// target binding order regardless of how the adapter orders its response; the
// request target set is deduped so the adapter is asked for each target once.
//
// This module imports no test framework. The `target` string is opaque here.

import { spawn } from 'node:child_process';
import type { Oracle } from '../artifacts/oracles.js';
import { invalidInputError } from '../util/errors.js';
import type { AdapterManifest } from './manifest.js';
import {
  resolveEnvelopeSchema,
  runEnvelopeSchema,
  type AdapterVerb,
  type OracleResult,
  type ResolveResult,
} from './types.js';

/** The raw outcome of one adapter subprocess round-trip (transport layer). */
export interface AdapterExecResult {
  /** Everything the adapter wrote to stdout. */
  stdout: string;
  /** Everything the adapter wrote to stderr (diagnostics only). */
  stderr: string;
  /** The process exit code, or null if it was killed / never exited. */
  code: number | null;
  /** True iff the process was killed for exceeding the timeout. */
  timedOut: boolean;
}

/**
 * The injectable transport: spawn `command argv[…]`, feed `input` on stdin,
 * resolve with the captured result. Injectable so failure modes (timeout,
 * non-zero exit, garbage) are hermetic in tests; defaults to a real subprocess.
 */
export type AdapterExec = (
  command: string,
  argv: readonly string[],
  input: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<AdapterExecResult>;

/** How the client resolves a bare executable name from an invocation string. */
export interface ResolvedExecutable {
  /** The command to actually spawn (e.g. an absolute path, or `node`). */
  command: string;
  /** Args prepended before the invocation's own args (e.g. the script path). */
  prefixArgs: string[];
}

export interface AdapterClientOptions {
  /** The parsed manifest (charter §Adapter Manifest & Transport). */
  manifest: AdapterManifest;
  /** Working directory the adapter subprocess runs in. */
  cwd: string;
  /**
   * Map the bare executable name in an invocation string to a real command.
   * `init` pins this to the hash-verified binary; tests point it at the built
   * stub. Default: run the name as-is (relies on PATH).
   */
  resolveExecutable?: (name: string) => ResolvedExecutable;
  /** Extra args appended after the verb (e.g. `['--tests', 'tests.json']`). */
  extraArgs?: readonly string[];
  /** Per-invocation timeout. A hung adapter is fail-closed at exit 3. */
  timeoutMs: number;
  /** Injectable transport; defaults to a real `child_process.spawn`. */
  exec?: AdapterExec;
}

export interface AdapterClient {
  /**
   * Batch dry-run: resolve each target to found|missing, in INPUT order. Shape-
   * compatible with the linter's `ResolveFn` (lint/traceability.ts). No execution.
   */
  resolve(targets: readonly string[]): Promise<ResolveResult[]>;
  /**
   * Execute every oracle's bound targets and join results back to oracle IDs.
   * skip→fail; any non-`pass` target fails its oracle. Oracle input order and
   * per-oracle binding order are preserved (deterministic).
   */
  run(oracles: readonly Oracle[]): Promise<OracleResult[]>;
}

const IDENTITY_RESOLVE: (name: string) => ResolvedExecutable = (name) => ({
  command: name,
  prefixArgs: [],
});

export function createAdapterClient(options: AdapterClientOptions): AdapterClient {
  const {
    manifest,
    cwd,
    resolveExecutable = IDENTITY_RESOLVE,
    extraArgs = [],
    timeoutMs,
    exec = defaultExec,
  } = options;

  /** Tokenize an invocation string, resolve its executable, and spawn one round-trip. */
  async function invoke(verb: AdapterVerb, targets: readonly string[]): Promise<unknown> {
    const invocation = manifest.invocations[verb];
    const tokens = invocation.split(/\s+/).filter((t) => t.length > 0);
    const name = tokens[0];
    if (name === undefined) {
      throw invalidInputError(
        'INVALID_ADAPTER_MANIFEST',
        `${manifest.name}: empty ${verb} invocation string.`,
        'Fix crucible-adapter.yaml against charter §Adapter Manifest & Transport.',
      );
    }
    const resolved = resolveExecutable(name);
    const argv = [...resolved.prefixArgs, ...tokens.slice(1), ...extraArgs];
    const input = JSON.stringify({ targets });

    let result: AdapterExecResult;
    try {
      result = await exec(resolved.command, argv, input, { cwd, timeoutMs });
    } catch (cause) {
      throw transportError(manifest, verb, `adapter transport failed — ${messageOf(cause)}`);
    }

    if (result.timedOut) {
      throw transportError(
        manifest,
        verb,
        `adapter timed out after ${timeoutMs}ms (a hung judge is fail-closed).`,
      );
    }
    if (result.code !== 0) {
      throw transportError(
        manifest,
        verb,
        `adapter exited ${result.code === null ? '(killed)' : String(result.code)}` +
          `${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
      );
    }

    try {
      return JSON.parse(result.stdout);
    } catch (cause) {
      throw transportError(
        manifest,
        verb,
        `adapter emitted non-JSON on stdout — ${messageOf(cause)}`,
      );
    }
  }

  return {
    async resolve(targets) {
      if (targets.length === 0) return [];
      const requested = dedupe(targets);
      const parsed = resolveEnvelopeSchema.safeParse(await invoke('resolve', requested));
      if (!parsed.success) {
        throw schemaError(manifest, 'resolve', parsed.error);
      }
      const byTarget = indexResults(parsed.data.results);
      // Join back in INPUT order; a target the adapter dropped is fail-closed.
      return targets.map((target) => {
        const result = byTarget.get(target);
        if (result === undefined) {
          throw transportError(
            manifest,
            'resolve',
            `adapter returned no result for requested target: ${target}`,
          );
        }
        return result;
      });
    },

    async run(oracles) {
      if (oracles.length === 0) return [];
      // Deduped target universe in first-appearance order (one ask per target).
      const universe = dedupe(oracles.flatMap((o) => o.binding.targets));
      const parsed = runEnvelopeSchema.safeParse(await invoke('run', universe));
      if (!parsed.success) {
        throw schemaError(manifest, 'run', parsed.error);
      }
      const byTarget = indexResults(parsed.data.results);
      // Join each oracle's targets in binding order; skip→fail, any non-pass fails.
      return oracles.map((oracle): OracleResult => {
        const targets = oracle.binding.targets.map((target) => {
          const result = byTarget.get(target);
          if (result === undefined) {
            throw transportError(
              manifest,
              'run',
              `adapter returned no result for oracle ${oracle.id} target: ${target}`,
            );
          }
          return result;
        });
        // Invariant 4: skip is fail. Fail-closed: only an all-pass oracle passes.
        const status = targets.every((t) => t.status === 'pass') ? 'pass' : 'fail';
        return {
          oracleId: oracle.id,
          requirement: oracle.binding.requirement,
          status,
          targets,
        };
      });
    },
  };
}

/** Distinct targets in first-appearance order (deterministic dedupe). */
function dedupe(targets: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const target of targets) {
    if (!seen.has(target)) {
      seen.add(target);
      ordered.push(target);
    }
  }
  return ordered;
}

/** Index results by target; first result for a target wins (deterministic). */
function indexResults<T extends { target: string }>(results: readonly T[]): Map<string, T> {
  const byTarget = new Map<string, T>();
  for (const result of results) {
    if (!byTarget.has(result.target)) byTarget.set(result.target, result);
  }
  return byTarget;
}

function transportError(manifest: AdapterManifest, verb: AdapterVerb, detail: string) {
  return invalidInputError(
    'ADAPTER_TRANSPORT',
    `adapter '${manifest.name}' (${verb}): ${detail}`,
    'The adapter is part of the TCB; a broken judge fails closed. Check the adapter binary and its pin.',
  );
}

function schemaError(manifest: AdapterManifest, verb: AdapterVerb, error: { issues: unknown[] }) {
  const issues = error.issues as { path: (string | number)[]; message: string }[];
  const detail = issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  return invalidInputError(
    'ADAPTER_TRANSPORT',
    `adapter '${manifest.name}' (${verb}): response violates the normalized result schema — ${detail}`,
    'The adapter emitted a result core cannot trust; a malformed verdict is never a pass.',
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default transport: spawn a real subprocess, write `input` to stdin, capture
 * stdout/stderr, enforce the timeout by killing the child. Never rejects for a
 * non-zero exit — that is reported via `code` and mapped to exit 3 by the client.
 */
const defaultExec: AdapterExec = (command, argv, input, { cwd, timeoutMs }) =>
  new Promise<AdapterExecResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...argv], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: AdapterExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, code, timedOut });
    });

    child.stdin.on('error', () => {
      // A broken pipe (adapter exited before reading stdin) surfaces via `close`.
    });
    child.stdin.write(input);
    child.stdin.end();
  });
