import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import {
  ClaudeCodeSubstrate,
  type SubstrateProcessResult,
  type SubstrateSpawn,
} from './claude-code.js';
import type { SubstrateRequest } from './types.js';

// TCB-adjacent: this is the ONLY class that spawns the `claude` binary
// (architecture.md §1, §6). The claude CLI itself is verified manually (spike
// note); here the spawn is injected so flag construction, transcript capture,
// and the returned-vs-thrown boundary are hermetic and deterministic.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-substrate-'));
  const rp = join(dir, '.crucible/context/propose.md');
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, 'You are the proposer.\n', 'utf8');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function req(overrides: Partial<SubstrateRequest> = {}): SubstrateRequest {
  return {
    role: 'propose',
    rolePromptPath: join(dir, '.crucible/context/propose.md'),
    taskPayload: 'author the greeting spec',
    cwd: dir,
    model: 'fable',
    transcriptPath: join(dir, '.crucible/transcripts/greeting/propose-1.jsonl'),
    ...overrides,
  };
}

/** A spawn that records how it was called and returns a canned process result. */
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

describe('ClaudeCodeSubstrate — invocation shape', () => {
  it('passes the role prompt as a system prompt and the payload on stdin', async () => {
    const { spawn, calls } = recordingSpawn({ stdout: '{"type":"result"}\n' });
    const sub = new ClaudeCodeSubstrate({ spawn });
    await sub.run(req());

    expect(calls).toHaveLength(1);
    const { command, argv, input } = calls[0]!;
    expect(command).toBe('claude');
    expect(argv).toContain('-p');
    // Trajectory capture requires stream-json + --verbose.
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    // Model is forwarded verbatim.
    expect(argv[argv.indexOf('--model') + 1]).toBe('fable');
    // Role prompt content (not path) travels as the appended system prompt.
    expect(argv).toContain('--append-system-prompt');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('You are the proposer.\n');
    // The work order goes on stdin, not the argv.
    expect(input).toBe('author the greeting spec');
    expect(argv).not.toContain('author the greeting spec');
  });

  it('honors a custom binary path (init pins the hash-verified binary)', async () => {
    const { spawn, calls } = recordingSpawn({});
    const sub = new ClaudeCodeSubstrate({ spawn, binPath: '/opt/pinned/claude' });
    await sub.run(req());
    expect(calls[0]!.command).toBe('/opt/pinned/claude');
  });

  it('forwards cwd and timeout to the spawn', async () => {
    const { spawn, calls } = recordingSpawn({});
    const sub = new ClaudeCodeSubstrate({ spawn });
    await sub.run(req({ timeoutMs: 5000 }));
    expect(calls[0]!.cwd).toBe(dir);
    expect(calls[0]!.timeoutMs).toBe(5000);
  });
});

describe('ClaudeCodeSubstrate — transcript capture', () => {
  it('writes the streamed stdout to transcriptPath, creating parent dirs', async () => {
    const { spawn } = recordingSpawn({ stdout: '{"type":"system"}\n{"type":"result"}\n' });
    const sub = new ClaudeCodeSubstrate({ spawn });
    const result = await sub.run(req());

    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe(
      '{"type":"system"}\n{"type":"result"}\n',
    );
    expect(result.exitCode).toBe(0);
  });

  it('preserves the (possibly truncated) transcript even on non-zero exit', async () => {
    const { spawn } = recordingSpawn({ code: 1, stdout: '{"type":"system"}\n' });
    const sub = new ClaudeCodeSubstrate({ spawn });
    const result = await sub.run(req());
    expect(result.exitCode).toBe(1);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe('{"type":"system"}\n');
  });
});

describe('ClaudeCodeSubstrate — returned vs thrown (frozen contract)', () => {
  it('RETURNS a non-zero exit rather than throwing (a dead author is judged by its artifacts)', async () => {
    const { spawn } = recordingSpawn({ code: 3, stdout: 'boom\n' });
    const sub = new ClaudeCodeSubstrate({ spawn });
    const result = await sub.run(req());
    expect(result.exitCode).toBe(3);
  });

  it('RETURNS a non-zero exit on timeout kill, with the transcript preserved', async () => {
    const { spawn } = recordingSpawn({ code: null, timedOut: true, stdout: 'partial' });
    const sub = new ClaudeCodeSubstrate({ spawn });
    const result = await sub.run(req({ timeoutMs: 10 }));
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe('partial');
  });

  it('THROWS SUBSTRATE_UNAVAILABLE (exit 3) when the role prompt is unreadable (cannot start)', async () => {
    const { spawn } = recordingSpawn({});
    const sub = new ClaudeCodeSubstrate({ spawn });
    await expect(sub.run(req({ rolePromptPath: join(dir, 'nope.md') }))).rejects.toSatisfy(
      (e: unknown) => isCrucibleError(e) && e.code === 'SUBSTRATE_UNAVAILABLE' && e.exit === 3,
    );
  });

  it('THROWS SUBSTRATE_UNAVAILABLE (exit 3) when the binary cannot be spawned', async () => {
    const spawn: SubstrateSpawn = async () => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const sub = new ClaudeCodeSubstrate({ spawn });
    await expect(sub.run(req())).rejects.toSatisfy(
      (e: unknown) => isCrucibleError(e) && e.code === 'SUBSTRATE_UNAVAILABLE' && e.exit === 3,
    );
  });
});
