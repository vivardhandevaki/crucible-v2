// FakeSubstrate — the test double behind every command test (architecture.md §6).
//
// It honors the frozen AgentSubstrate contract exactly — writes scripted files
// under cwd, always leaves a transcript at request.transcriptPath, returns the
// scripted exit code — so command tests exercise the real "run then judge the
// artifacts" flow (invariant 2) without a network or a live agent. The scripting
// shape (`FakeScript`) is unfrozen test infrastructure, not part of the contract.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentSubstrate, SubstrateRequest, SubstrateResult } from './types.js';

/** What one scripted session produces. Every field is optional. */
export interface FakeScript {
  /** Files to write, keyed by path relative to `cwd` (absolute paths allowed).
   * These stand in for the artifacts a real role would author. */
  files?: Record<string, string>;
  /** Transcript body to leave at `transcriptPath`. Defaults to a canned line. */
  transcript?: string;
  /** Process exit code to return. Defaults to 0. Never trusted for success
   * (invariant 2) — present only so tests can drive the exitCode branch. */
  exitCode?: number;
}

/** A fixed script, or one computed per request (e.g. a different role bundle). */
export type FakeScriptResolver =
  FakeScript | ((req: SubstrateRequest) => FakeScript | Promise<FakeScript>);

export class FakeSubstrate implements AgentSubstrate {
  /** Every request this fake has served, in order — for command-test assertions. */
  readonly calls: SubstrateRequest[] = [];

  constructor(private readonly script: FakeScriptResolver = {}) {}

  async run(req: SubstrateRequest): Promise<SubstrateResult> {
    this.calls.push(req);
    const script = typeof this.script === 'function' ? await this.script(req) : this.script;

    for (const [path, content] of Object.entries(script.files ?? {})) {
      const abs = isAbsolute(path) ? path : join(req.cwd, path);
      writeFileToDir(abs, content);
    }

    // Contract: a transcript exists on every returned result.
    writeFileToDir(req.transcriptPath, script.transcript ?? defaultTranscript(req));

    return { exitCode: script.exitCode ?? 0, transcriptPath: req.transcriptPath };
  }
}

function writeFileToDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** A minimal, valid-looking stream-json transcript when a test scripts none. */
function defaultTranscript(req: SubstrateRequest): string {
  return (
    JSON.stringify({ type: 'system', subtype: 'init', role: req.role, model: req.model }) +
    '\n' +
    JSON.stringify({ type: 'result', subtype: 'success' }) +
    '\n'
  );
}
