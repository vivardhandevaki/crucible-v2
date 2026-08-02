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
export const DEFAULT_CODEX_SANDBOX = 'workspace-write';
export type CodexSandboxMode = 'workspace-write' | 'danger-full-access';

const NESTED_SANDBOX_FAILURE = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted';
const SANDBOX_FAILURE_HINT = [
  'Codex exited in isolated workspace-write mode. Crucible will not automatically retry with broader permissions.',
  'If this host cannot run Codex in a nested sandbox, add agent.codex_sandbox: danger-full-access only to gitignored .crucible/local.yaml.',
  'That opt-in gives the child process full access to your machine; use it only when you accept that trade-off. It cannot affect CI or merge decisions.',
].join(' ');

export interface CodexSubstrateOptions {
  binPath?: string;
  spawn?: SubstrateSpawn;
  readRolePrompt?: (path: string) => string;
  sandbox?: CodexSandboxMode;
  reportSandboxFailure?: (message: string) => void;
}

export class CodexSubstrate implements AgentSubstrate {
  private readonly binPath: string;
  private readonly spawn: SubstrateSpawn;
  private readonly readRolePrompt: (path: string) => string;

  private readonly sandbox: CodexSandboxMode;
  private readonly reportSandboxFailure: (message: string) => void;
  constructor(options: CodexSubstrateOptions = {}) {
    this.binPath = options.binPath ?? CODEX_BIN;
    this.spawn = options.spawn ?? defaultSubstrateSpawn;
    this.readRolePrompt = options.readRolePrompt ?? ((path) => readFileSync(path, 'utf8'));
    this.sandbox = options.sandbox ?? DEFAULT_CODEX_SANDBOX;
    this.reportSandboxFailure =
      options.reportSandboxFailure ?? ((message) => process.stderr.write(`${message}\n`));
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
      proc = await this.spawn(this.binPath, buildArgv(req, rolePrompt, this.sandbox), {
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
    const exitCode = processExitCode(proc);
    if (
      exitCode !== 0 &&
      this.sandbox === DEFAULT_CODEX_SANDBOX &&
      proc.stderr.includes(NESTED_SANDBOX_FAILURE)
    ) {
      try {
        this.reportSandboxFailure(SANDBOX_FAILURE_HINT);
      } catch {
        // A convenience diagnostic cannot disrupt transcript preservation or judgment.
      }
    }
    return { exitCode, transcriptPath: req.transcriptPath };
  }
}

function buildArgv(req: SubstrateRequest, rolePrompt: string, sandbox: CodexSandboxMode): string[] {
  return [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    sandbox,
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
