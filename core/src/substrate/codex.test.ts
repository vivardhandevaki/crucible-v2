import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { CodexSubstrate } from './codex.js';
import type { SubstrateProcessResult, SubstrateSpawn } from './process.js';
import type { SubstrateRequest } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-substrate-'));
  const role = join(dir, '.crucible/context/propose.md');
  mkdirSync(dirname(role), { recursive: true });
  writeFileSync(role, 'You are the proposer.\nUse "quoted" evidence.\n', 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function req(overrides: Partial<SubstrateRequest> = {}): SubstrateRequest {
  return {
    role: 'propose',
    rolePromptPath: join(dir, '.crucible/context/propose.md'),
    taskPayload: 'author the greeting spec',
    cwd: dir,
    model: 'gpt-5.6-sol',
    transcriptPath: join(dir, '.crucible/transcripts/greeting/propose-1.jsonl'),
    ...overrides,
  };
}

function recordingSpawn(result: Partial<SubstrateProcessResult>) {
  const calls: {
    command: string;
    argv: readonly string[];
    input: string;
    cwd: string;
    timeoutMs: number | undefined;
  }[] = [];
  const spawn: SubstrateSpawn = async (command, argv, options) => {
    calls.push({
      command,
      argv,
      input: options.input,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    return { code: 0, timedOut: false, stdout: '', stderr: '', ...result };
  };
  return { spawn, calls };
}

describe('CodexSubstrate — invocation shape', () => {
  it('uses an ephemeral, config-isolated workspace-write exec and feeds the task on stdin', async () => {
    const { spawn, calls } = recordingSpawn({ stdout: '{"type":"thread.started"}\n' });
    await new CodexSubstrate({ spawn }).run(req());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('codex');
    expect(call.argv).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--sandbox',
      'workspace-write',
      '--color',
      'never',
      '--model',
      'gpt-5.6-sol',
      '--cd',
      dir,
      '-c',
      'developer_instructions="You are the proposer.\\nUse \\"quoted\\" evidence.\\n"',
      '-',
    ]);
    expect(call.input).toBe('author the greeting spec');
    expect(call.cwd).toBe(dir);
  });

  it('honors a custom binary and forwards a timeout', async () => {
    const { spawn, calls } = recordingSpawn({});
    await new CodexSubstrate({ spawn, binPath: '/opt/pinned/codex' }).run(req({ timeoutMs: 5000 }));
    expect(calls[0]!.command).toBe('/opt/pinned/codex');
    expect(calls[0]!.timeoutMs).toBe(5000);
  });

  it('uses danger-full-access only when the local runtime explicitly opts in', async () => {
    const { spawn, calls } = recordingSpawn({});
    await new CodexSubstrate({ spawn, sandbox: 'danger-full-access' }).run(req());

    expect(calls[0]!.argv).toContain('--sandbox');
    expect(calls[0]!.argv[calls[0]!.argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
  });

  it('never retries a failed workspace-write session with broader permissions', async () => {
    const { spawn, calls } = recordingSpawn({
      code: 1,
      stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    });
    const diagnostics: string[] = [];

    const result = await new CodexSubstrate({
      spawn,
      reportSandboxFailure: (message) => diagnostics.push(message),
    }).run(req());

    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toContain('workspace-write');
    expect(diagnostics).toEqual([expect.stringContaining('.crucible/local.yaml')]);
    expect(diagnostics[0]).toContain('danger-full-access');
    expect(diagnostics[0]).toContain('full access');
    expect(diagnostics[0]).toContain('will not automatically retry');
  });
});

describe('CodexSubstrate — frozen result contract', () => {
  it('preserves JSONL stdout verbatim on success and non-zero exit', async () => {
    const transcript = '{"type":"thread.started"}\n{"type":"error"}\n';
    const { spawn } = recordingSpawn({ code: 7, stdout: transcript });
    const result = await new CodexSubstrate({ spawn }).run(req());
    expect(result.exitCode).toBe(7);
    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe(transcript);
  });

  it('returns timeout as non-zero and preserves partial output', async () => {
    const { spawn } = recordingSpawn({ code: null, timedOut: true, stdout: 'partial\n' });
    const result = await new CodexSubstrate({ spawn }).run(req({ timeoutMs: 1 }));
    expect(result.exitCode).toBe(124);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe('partial\n');
  });

  it('throws exit 3 when the role prompt is unreadable', async () => {
    const { spawn } = recordingSpawn({});
    await expect(
      new CodexSubstrate({ spawn }).run(req({ rolePromptPath: join(dir, 'missing.md') })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCrucibleError(error) && error.code === 'SUBSTRATE_UNAVAILABLE' && error.exit === 3,
    );
  });

  it('throws exit 3 when the binary cannot spawn', async () => {
    const spawn: SubstrateSpawn = async () => {
      throw new Error('spawn codex ENOENT');
    };
    await expect(new CodexSubstrate({ spawn }).run(req())).rejects.toSatisfy(
      (error: unknown) =>
        isCrucibleError(error) && error.code === 'SUBSTRATE_UNAVAILABLE' && error.exit === 3,
    );
  });
});
