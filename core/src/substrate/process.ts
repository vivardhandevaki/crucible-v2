// Shared subprocess transport for command-line agent substrates. Provider-
// specific argv and diagnostics stay in their own modules; timeout handling,
// capture, and transcript persistence must behave identically for every agent.

import { spawn as childSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 1;

export interface SubstrateProcessResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type SubstrateSpawn = (
  command: string,
  argv: readonly string[],
  options: { cwd: string; input: string; timeoutMs?: number },
) => Promise<SubstrateProcessResult>;

export function writeTranscript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

export function processExitCode(result: SubstrateProcessResult): number {
  return result.timedOut ? TIMEOUT_EXIT : (result.code ?? KILLED_EXIT);
}

export const defaultSubstrateSpawn: SubstrateSpawn = (command, argv, { cwd, input, timeoutMs }) =>
  new Promise<SubstrateProcessResult>((resolvePromise, rejectPromise) => {
    const child = childSpawn(command, [...argv], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
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
      clearTimer();
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolvePromise({ stdout, stderr, code, timedOut });
    });

    child.stdin.on('error', () => {
      // Broken pipe (session exited before reading stdin) surfaces via 'close'.
    });
    child.stdin.write(input);
    child.stdin.end();
  });
