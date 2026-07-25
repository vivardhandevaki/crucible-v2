// CLI wiring for `crucible propose` — binds the deterministic core (`propose`)
// to the real, non-deterministic edges: the ClaudeCode substrate, the OpenSpec
// scaffolder, the adapter resolver, the wall clock, and model routing from the
// convenience config. The core stays testable and reproducible (invariant 12);
// this file is the thin shim that supplies live dependencies at invocation time
// and maps the verdict to the process exit code.
//
// A red judgment is signaled with `CheckFailure` (exit 1) AFTER the report is
// rendered — the agent's bundle failed, the tool worked (same pattern as
// verify.cli). Genuine pre-session failures (bad name, existing change, missing
// role prompt) throw `CrucibleError` (exit 2/3) from the core.
//
// The binding resolver must spawn the pinned adapter, which `init` records
// (P2). Until then that one edge fails closed (invariant 3) — but only when
// judgment actually reaches the lint, so propose without an adapter pin still
// authors and bundle-checks (the P1-16 tracer wires a real stub-adapter client).

import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { propose, type ProposeDeps } from './propose.js';
import { loadConvenienceConfig } from '../config/convenience.js';
import { ClaudeCodeSubstrate } from '../substrate/claude-code.js';
import type { ResolveFn } from '../lint/traceability.js';
import { CheckFailure, invalidInputError, preconditionError } from '../util/errors.js';

/** Model used when convenience config routes nothing to `models.propose`. */
const DEFAULT_PROPOSE_MODEL = 'claude-opus-4-8';

/** Register the real `propose` subcommand on the program. */
export function registerPropose(program: Command): void {
  program
    .command('propose')
    .description('Draft a change bundle (spec + oracles) for approval')
    .argument('<change>', 'the change name to create (lowercase kebab-case)')
    .argument('<intent>', 'what should change and why, in one quoted string')
    .option(
      '--revise',
      'regenerate an existing, not-yet-approved bundle coherently (charter §Editing Artifacts)',
      false,
    )
    .action(async (change: string, intent: string, opts: { revise?: boolean }) => {
      const root = process.cwd();
      const result = await propose(
        { root, change, intent, model: proposeModel(root), revise: opts.revise === true },
        liveDeps(root),
      );

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(result.report) + '\n');
      } else {
        process.stdout.write(result.render + '\n');
        process.stdout.write(`Transcript: ${result.transcriptPath}\n`);
      }

      // A red judgment exits 1 (architecture.md §2) — a verdict, not an error.
      if (result.report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** Model routing: convenience `models.propose`, else the default (invariant 11
 * — this is convenience shaping a session, never an enforcement decision). */
function proposeModel(root: string): string {
  return loadConvenienceConfig(root).models['propose'] ?? DEFAULT_PROPOSE_MODEL;
}

/** The live dependencies for a real propose invocation. */
function liveDeps(root: string): ProposeDeps {
  return {
    substrate: new ClaudeCodeSubstrate(),
    scaffold: (change) => scaffoldViaOpenSpec(root, change),
    resolve: liveResolveUnavailable,
    now: () => new Date().toISOString(),
  };
}

/**
 * The spike-determined scaffolding mechanism (spike-notes §Repro): spawn the
 * pinned OpenSpec CLI. Non-zero exit → fail closed; the core additionally
 * verifies the change dir exists afterwards (a scaffolder is not trusted on
 * silence any more than an agent is).
 */
function scaffoldViaOpenSpec(root: string, change: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'npx',
      ['openspec', 'new', 'change', change, '--schema', 'crucible', '--json'],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (cause) =>
      reject(
        invalidInputError(
          'SCAFFOLD_FAILED',
          `Could not spawn the OpenSpec CLI to scaffold ${change}: ${cause.message}`,
          'Ensure the pinned @fission-ai/openspec devDependency is installed (npm install).',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          invalidInputError(
            'SCAFFOLD_FAILED',
            `\`openspec new change ${change}\` exited ${code ?? 'by signal'}${stderr ? ` — ${stderr.trim()}` : ''}.`,
            'Check that this repo is OpenSpec-initialized with the crucible schema (openspec/config.yaml).',
          ),
        );
    });
  });
}

/**
 * The binding resolver spawns the pinned adapter (P1-11 client), which `init`
 * records in the project config (P2). Until that pin exists, fail closed rather
 * than lint against no resolver.
 */
const liveResolveUnavailable: ResolveFn = () => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then propose runs only via its injectable core (see the P1-16 tracer).',
  );
};
