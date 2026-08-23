// CodexSubstrate — provider-specific command construction for fresh, headless
// Codex sessions. Shared process behavior lives in process.ts.

import { readFileSync } from 'node:fs';
import { invalidInputError } from '../util/errors.js';
import {
  defaultSubstrateSpawn,
  processExitCode,
  type SubstrateSpawn,
  writeTranscript,
} from './process.js';
import type { AgentSubstrate, SubstrateRequest, SubstrateResult } from './types.js';

export const CODEX_BIN = 'codex';

export interface CodexSubstrateOptions {
  binPath?: string;
  spawn?: SubstrateSpawn;
  readRolePrompt?: (path: string) => string;
}

export class CodexSubstrate implements AgentSubstrate {
  private readonly binPath: string;
  private readonly spawn: SubstrateSpawn;
  private readonly readRolePrompt: (path: string) => string;

  constructor(options: CodexSubstrateOptions = {}) {
    this.binPath = options.binPath ?? CODEX_BIN;
    this.spawn = options.spawn ?? defaultSubstrateSpawn;
    this.readRolePrompt = options.readRolePrompt ?? ((path) => readFileSync(path, 'utf8'));
  }

  async run(req: SubstrateRequest): Promise<SubstrateResult> {
    let rolePrompt: string;
    try {
      rolePrompt = this.readRolePrompt(req.rolePromptPath);
    } catch {
      throw unavailable(
        `role prompt is unreadable: ${req.rolePromptPath}`,
        `Ensure the ${req.role} role prompt exists at ${req.rolePromptPath} (run 'crucible init').`,
      );
    }

    let proc;
    try {
      proc = await this.spawn(this.binPath, buildArgv(req, rolePrompt), {
        cwd: req.cwd,
        input: req.taskPayload,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      });
    } catch {
      throw unavailable(
        `could not spawn the agent binary '${this.binPath}'`,
        `Install OpenAI Codex, authenticate it, and ensure '${this.binPath}' is on PATH.`,
      );
    }

    writeTranscript(req.transcriptPath, proc.stdout);
    return { exitCode: processExitCode(proc), transcriptPath: req.transcriptPath };
  }
}

function buildArgv(req: SubstrateRequest, rolePrompt: string): string[] {
  return [
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
    req.model,
    '--cd',
    req.cwd,
    '-c',
    `developer_instructions=${JSON.stringify(rolePrompt)}`,
    '-',
  ];
}

function unavailable(message: string, hint: string) {
  return invalidInputError(
    'SUBSTRATE_UNAVAILABLE',
    `agent substrate cannot start — ${message}`,
    hint,
  );
}
