// CLI wiring for `crucible propose` — binds the deterministic core (`propose`)
// to the real, non-deterministic edges: the selected agent substrate, the OpenSpec
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
import { resolveAgentRuntime } from '../substrate/runtime.js';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { propose, type ProposeDeps } from './propose.js';
import { parseTypeName, type ChangeType } from '../changetype/changetype.js';
import { CheckFailure, invalidInputError } from '../util/errors.js';

import { openspecExecutable } from './openspec-runner.js';
/** Model used when convenience config routes nothing to `models.propose`. */

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
    .option(
      '--type <type>',
      'change type: feature | bugfix | refactor (default: inferred from the intent)',
    )
    .action(async (change: string, intent: string, opts: { revise?: boolean; type?: string }) => {
      const root = process.cwd();
      // `--type` is validated fail-closed here (exit 3 on an unknown type); omitted
      // → the core infers it from the intent (charter §Change Types).
      const type: ChangeType | undefined =
        opts.type !== undefined ? parseTypeName(opts.type) : undefined;
      const result = await propose(
        {
          root,
          change,
          intent,
          model: proposeModel(root),
          revise: opts.revise === true,
          ...(type ? { type } : {}),
        },
        liveDeps(root),
      );

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(result.report) + '\n');
      } else {
        // Say the type (charter §Change Types: "infers ... and says so"), noting
        // whether it was inferred or forced with `--type`.
        const how = type !== undefined ? 'forced via --type' : 'inferred from intent';
        process.stdout.write(`Change type: ${result.type} (${how})\n`);
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
  return resolveAgentRuntime(root, 'propose').model;
}

/** The live dependencies for a real propose invocation. */
function liveDeps(root: string): ProposeDeps {
  const adapter = loadPinnedAdapterClient(root);
  return {
    substrate: resolveAgentRuntime(root, 'propose').substrate,
    scaffold: (change, schema) => scaffoldViaOpenSpec(root, change, schema),
    resolve: (targets) => adapter.resolve(targets),
    now: () => new Date().toISOString(),
  };
}

/**
 * The spike-determined scaffolding mechanism (spike-notes §Repro): spawn the
 * pinned OpenSpec CLI with the change TYPE's sibling schema (design phase-2.md §4:
 * `propose` passes `--schema` explicitly — spike D5, never ambient resolution).
 * Non-zero exit → fail closed; the core additionally verifies the change dir
 * exists afterwards (a scaffolder is not trusted on silence any more than an agent).
 */
function scaffoldViaOpenSpec(root: string, change: string, schema: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [openspecExecutable(), 'new', 'change', change, '--schema', schema, '--json'],
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
          'Rebuild or reinstall this Crucible checkout before running propose.',
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
