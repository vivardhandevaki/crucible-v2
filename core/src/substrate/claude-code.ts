// ClaudeCodeSubstrate — the ONLY class that spawns the `claude` binary
// (architecture.md §1: "Nothing outside `substrate` invokes an agent"; §6). Every
// CLI-flag specific to headless Claude Code is isolated here, so a future
// pluggable substrate is a refactor of this one file, not a grep across core.
//
// Verified manually against installed Claude Code (see docs/design/spike-notes.md
// "P1-08 addendum"). The invocation, headless:
//   claude -p --output-format stream-json --verbose --model <m>
//          --permission-mode <mode> --append-system-prompt <role prompt>
// with the work-order text fed on stdin. `--output-format stream-json --verbose`
// makes the CLI emit the full trajectory as JSONL on stdout; we capture that
// stream verbatim into the transcript (the trajectory artifact, architecture §6).
//
// Returned vs thrown (frozen contract, architecture.md §6): every outcome of a
// *started* run is RETURNED — non-zero exit, agent crash, timeout kill — because
// a dead author is judged by the artifacts it failed to produce (invariant 2),
// not by this class. Only inability to START throws SUBSTRATE_UNAVAILABLE (exit
// 3): an unreadable role prompt, or a binary that will not spawn.

import { readFileSync } from 'node:fs';
import { invalidInputError } from '../util/errors.js';
import {
  defaultSubstrateSpawn,
  processExitCode,
  type SubstrateProcessResult,
  type SubstrateSpawn,
  writeTranscript,
} from './process.js';
import type { AgentSubstrate, SubstrateRequest, SubstrateResult } from './types.js';

export type { SubstrateProcessResult, SubstrateSpawn } from './process.js';

/** The default binary name; `init` may pin this to a hash-verified path. */
export const CLAUDE_BIN = 'claude';

export interface ClaudeCodeSubstrateOptions {
  /** Binary to spawn. Default `claude`; `init` pins the hash-verified path. */
  binPath?: string;
  /** Permission mode for the headless session. Default `bypassPermissions`:
   * a headless run has no interactive approver, so any prompt would hang until
   * the timeout. Isolated here as the single place the policy is chosen. */
  permissionMode?: string;
  /** Injectable transport; defaults to a real `child_process.spawn`. */
  spawn?: SubstrateSpawn;
  /** Injectable role-prompt reader; defaults to `readFileSync`. Tests override
   * to exercise the unreadable-prompt (cannot-start) branch deterministically. */
  readRolePrompt?: (path: string) => string;
}

export class ClaudeCodeSubstrate implements AgentSubstrate {
  private readonly binPath: string;
  private readonly permissionMode: string;
  private readonly spawn: SubstrateSpawn;
  private readonly readRolePrompt: (path: string) => string;

  constructor(options: ClaudeCodeSubstrateOptions = {}) {
    this.binPath = options.binPath ?? CLAUDE_BIN;
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.spawn = options.spawn ?? defaultSubstrateSpawn;
    this.readRolePrompt = options.readRolePrompt ?? ((path) => readFileSync(path, 'utf8'));
  }

  async run(req: SubstrateRequest): Promise<SubstrateResult> {
    // Cannot-start #1: the role prompt must be readable before we spawn.
    let rolePrompt: string;
    try {
      rolePrompt = this.readRolePrompt(req.rolePromptPath);
    } catch {
      throw unavailable(
        `role prompt is unreadable: ${req.rolePromptPath}`,
        `Ensure the ${req.role} role prompt exists at ${req.rolePromptPath} (run 'crucible init').`,
      );
    }

    const argv = buildArgv({
      model: req.model,
      permissionMode: this.permissionMode,
      rolePrompt,
    });

    // Cannot-start #2: the binary itself must spawn.
    let proc: SubstrateProcessResult;
    try {
      proc = await this.spawn(this.binPath, argv, {
        cwd: req.cwd,
        input: req.taskPayload,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      });
    } catch {
      throw unavailable(
        `could not spawn the agent binary '${this.binPath}'`,
        `Install Claude Code and ensure '${this.binPath}' is on PATH (or pin it via init).`,
      );
    }

    // The trajectory is always persisted — possibly truncated on crash/timeout.
    writeTranscript(req.transcriptPath, proc.stdout);

    // Every started-run outcome is RETURNED, never thrown (frozen contract).
    const exitCode = processExitCode(proc);
    return { exitCode, transcriptPath: req.transcriptPath };
  }
}

/** The single place headless-Claude-Code flags are assembled (architecture §6). */
function buildArgv(params: {
  model: string;
  permissionMode: string;
  rolePrompt: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    params.model,
    '--permission-mode',
    params.permissionMode,
    '--append-system-prompt',
    params.rolePrompt,
  ];
}

function unavailable(message: string, hint: string) {
  return invalidInputError(
    'SUBSTRATE_UNAVAILABLE',
    `agent substrate cannot start — ${message}`,
    hint,
  );
}
