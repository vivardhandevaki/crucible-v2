import {
  STUB_ADAPTER_BIN_PATH,
  STUB_ADAPTER_MANIFEST_PATH,
  TOY_REPO_ROOT,
} from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import type { Oracle } from '../artifacts/oracles.js';
import { isCrucibleError } from '../util/errors.js';
import { createAdapterClient, type AdapterExec, type AdapterExecResult } from './client.js';
import { loadManifest } from './manifest.js';

// TCB: the adapter client is exactly as security-critical as the harness — an
// adapter decides whether checks pass (charter §Adapters Are Part of the TCB).
// The acceptance bar (task P1-11): join stub results to oracle IDs; skip on an
// oracle target → fail; adapter timeout / non-zero exit / garbage JSON → exit 3;
// results stable-ordered. Integration tests spawn the REAL built stub; failure
// modes are injected hermetically so there is no wall-clock flakiness.

const manifest = loadManifest(STUB_ADAPTER_MANIFEST_PATH);

/**
 * A client wired to spawn the real built stub. The manifest names the bin
 * `crucible-adapter-stub`; we resolve that to `node <dist/cli.js>` and point it
 * at the toy repo's tests.json via `--tests`, run from the toy repo cwd.
 */
function realClient() {
  return createAdapterClient({
    manifest,
    cwd: TOY_REPO_ROOT,
    resolveExecutable: (name) =>
      name === 'crucible-adapter-stub'
        ? { command: process.execPath, prefixArgs: [STUB_ADAPTER_BIN_PATH] }
        : { command: name, prefixArgs: [] },
    extraArgs: ['--tests', 'tests.json'],
    timeoutMs: 10_000,
  });
}

/** A client whose transport is a canned exec — hermetic, deterministic. */
function stubbedClient(exec: AdapterExec) {
  return createAdapterClient({
    manifest,
    cwd: TOY_REPO_ROOT,
    resolveExecutable: (name) => ({ command: name, prefixArgs: [] }),
    exec,
    timeoutMs: 10_000,
  });
}

/** Minimal oracle factory — only the fields the client reads (id + binding.targets). */
function oracle(id: string, targets: string[], requirement = 'REQ-x-1'): Oracle {
  return {
    id,
    title: id,
    heading: `## ${id}`,
    line: 1,
    binding: { requirement, kind: 'unit', runner: 'stub', targets },
  };
}

function ok(stdout: string): AdapterExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false };
}

describe('adapter client — resolve (integration, real stub)', () => {
  it('joins resolve results to targets in input order (found + missing)', async () => {
    const client = realClient();
    const results = await client.resolve([
      'greeting::no_such_test',
      'greeting::returns_hello_for_a_name',
      'greeting::streams_large_input',
    ]);
    expect(results).toEqual([
      { target: 'greeting::no_such_test', status: 'missing' },
      {
        target: 'greeting::returns_hello_for_a_name',
        status: 'found',
        targetFile: 'tests/greeting.test.ts',
      },
      { target: 'greeting::streams_large_input', status: 'missing' },
    ]);
  });

  it('satisfies the linter ResolveFn shape (empty batch → empty results)', async () => {
    const client = realClient();
    expect(await client.resolve([])).toEqual([]);
  });
});

describe('adapter client — run + ORC join (integration, real stub)', () => {
  it('joins run results back to their oracle IDs', async () => {
    const client = realClient();
    const oracles = [
      oracle('ORC-greeting-001', ['greeting::returns_hello_for_a_name']),
      oracle('ORC-greeting-002', ['greeting::rejects_null_bytes']),
    ];
    const results = await client.run(oracles);
    expect(results).toEqual([
      {
        oracleId: 'ORC-greeting-001',
        requirement: 'REQ-x-1',
        status: 'pass',
        targets: [{ target: 'greeting::returns_hello_for_a_name', status: 'pass' }],
      },
      {
        oracleId: 'ORC-greeting-002',
        requirement: 'REQ-x-1',
        status: 'fail',
        targets: [
          {
            target: 'greeting::rejects_null_bytes',
            status: 'fail',
            message: "expected 'Hello, ab!' but got 'Hello, a\\u0000b!'",
          },
        ],
      },
    ]);
  });

  it('an oracle binding multiple targets fails if any single target fails', async () => {
    const client = realClient();
    const results = await client.run([
      oracle('ORC-greeting-multi', [
        'greeting::returns_hello_for_a_name',
        'greeting::rejects_null_bytes',
      ]),
    ]);
    expect(results[0]!.oracleId).toBe('ORC-greeting-multi');
    expect(results[0]!.status).toBe('fail');
    // both targets are reported, in binding order.
    expect(results[0]!.targets.map((t) => t.target)).toEqual([
      'greeting::returns_hello_for_a_name',
      'greeting::rejects_null_bytes',
    ]);
  });
});

describe('adapter client — skip → fail for oracle targets (invariant 4)', () => {
  it('reports a skipped oracle target as fail (real stub)', async () => {
    const client = realClient();
    const results = await client.run([oracle('ORC-greeting-skip', ['greeting::is_localized'])]);
    expect(results[0]!.status).toBe('fail');
    // the underlying adapter status is surfaced verbatim for the trace; only the
    // JOINED oracle verdict is coerced to fail.
    const t = results[0]!.targets[0]!;
    expect(t.status).toBe('skip');
    expect(t.message).toBe('localization not implemented; skipped');
  });

  it('reports an error target (uncollectible) as fail (real stub)', async () => {
    const client = realClient();
    const results = await client.run([
      oracle('ORC-greeting-err', ['greeting::streams_large_input']),
    ]);
    expect(results[0]!.status).toBe('fail');
    expect(results[0]!.targets[0]!.status).toBe('error');
  });
});

describe('adapter client — stable ordering (invariant 12)', () => {
  it('run results follow oracle input order regardless of adapter reordering', async () => {
    // Adapter deliberately returns results in reverse of the request order.
    const exec: AdapterExec = (_command, _argv, input) => {
      const { targets } = JSON.parse(input) as { targets: string[] };
      const results = [...targets].reverse().map((target) => ({ target, status: 'pass' as const }));
      return Promise.resolve(ok(JSON.stringify({ results })));
    };
    const client = stubbedClient(exec);
    const results = await client.run([
      oracle('ORC-a', ['t-a']),
      oracle('ORC-b', ['t-b']),
      oracle('ORC-c', ['t-c']),
    ]);
    expect(results.map((r) => r.oracleId)).toEqual(['ORC-a', 'ORC-b', 'ORC-c']);
  });

  it('deduplicates the target request but joins every oracle sharing a target', async () => {
    // Two oracles bind the same target; the adapter is asked for it once.
    let requested: string[] = [];
    const exec: AdapterExec = (_command, _argv, input) => {
      requested = (JSON.parse(input) as { targets: string[] }).targets;
      const results = requested.map((target) => ({ target, status: 'pass' as const }));
      return Promise.resolve(ok(JSON.stringify({ results })));
    };
    const client = stubbedClient(exec);
    const results = await client.run([oracle('ORC-a', ['shared']), oracle('ORC-b', ['shared'])]);
    expect(requested).toEqual(['shared']); // asked once
    expect(results.map((r) => r.oracleId)).toEqual(['ORC-a', 'ORC-b']);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });
});

describe('adapter client — fail-closed transport (each → exit 3)', () => {
  it('non-zero adapter exit → exit 3', async () => {
    const exec: AdapterExec = () =>
      Promise.resolve({ stdout: '', stderr: 'boom', code: 1, timedOut: false });
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('adapter timeout → exit 3', async () => {
    const exec: AdapterExec = () =>
      Promise.resolve({ stdout: '', stderr: '', code: null, timedOut: true });
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('garbage (non-JSON) stdout → exit 3', async () => {
    const exec: AdapterExec = () => Promise.resolve(ok('this is not json at all'));
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('well-formed JSON that violates the result schema → exit 3', async () => {
    // status is not a member of the normalized enum.
    const exec: AdapterExec = () =>
      Promise.resolve(ok(JSON.stringify({ results: [{ target: 't-a', status: 'weird' }] })));
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('missing `results` envelope → exit 3', async () => {
    const exec: AdapterExec = () => Promise.resolve(ok(JSON.stringify({ nope: [] })));
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('adapter drops a requested target (returns fewer results) → exit 3', async () => {
    // Fail-closed: a judge that silently vanished must never pass.
    const exec: AdapterExec = () => Promise.resolve(ok(JSON.stringify({ results: [] })));
    const client = stubbedClient(exec);
    await expect(client.run([oracle('ORC-a', ['t-a'])])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('resolve: garbage stdout → exit 3', async () => {
    const exec: AdapterExec = () => Promise.resolve(ok('{ broken'));
    const client = stubbedClient(exec);
    await expect(client.resolve(['t-a'])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });

  it('resolve: a resolve result with a run-only status → exit 3', async () => {
    // resolve may only report found|missing; `pass` is a schema violation.
    const exec: AdapterExec = () =>
      Promise.resolve(ok(JSON.stringify({ results: [{ target: 't-a', status: 'pass' }] })));
    const client = stubbedClient(exec);
    await expect(client.resolve(['t-a'])).rejects.toSatisfy(
      (err: unknown) => isCrucibleError(err) && err.exit === 3,
    );
  });
});

describe('adapter client — real stub, verb reaches the adapter correctly', () => {
  it('run with zero oracles makes no adapter call and returns []', async () => {
    let called = false;
    const exec: AdapterExec = () => {
      called = true;
      return Promise.resolve(ok(JSON.stringify({ results: [] })));
    };
    const client = stubbedClient(exec);
    expect(await client.run([])).toEqual([]);
    expect(called).toBe(false);
  });
});
