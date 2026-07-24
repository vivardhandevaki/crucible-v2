// CLI wiring for `crucible implement` — binds the deterministic core
// (`implement`) to the real, non-deterministic edges: the ClaudeCode substrate,
// the adapter-backed resolver + oracle runner (for the local verify), the wall
// clock, and model routing from the convenience config. The core stays testable
// and reproducible (invariant 12); this file is the thin shim that supplies live
// dependencies at invocation time and maps the verdict to the process exit code.
//
// A red local-verify verdict is signaled with `CheckFailure` (exit 1) AFTER the
// report is rendered — same pattern as verify.cli / propose.cli. Genuine failures
// (no/void approval, missing role prompt, a tasks session that produced no
// tasks.md) throw `CrucibleError` (exit 2/3) from the core.
//
// The resolver + oracle runner must spawn the pinned adapter via the P1-11
// client, which `init` records (P2). Until that pin exists they fail closed
// (invariant 3) — the local verify runs only through its injectable core (the
// P1-16 tracer wires a real stub-adapter client into these deps).

import type { Command } from 'commander';
import { implement, type ImplementDeps } from './implement.js';
import { loadConvenienceConfig } from '../config/convenience.js';
import { ClaudeCodeSubstrate } from '../substrate/claude-code.js';
import type { ResolveFn } from '../lint/traceability.js';
import { CheckFailure, preconditionError } from '../util/errors.js';

/** Model used when convenience config routes nothing to `models.implement`. */
const DEFAULT_IMPLEMENT_MODEL = 'claude-opus-4-8';

/** Register the real `implement` subcommand on the program. */
export function registerImplement(program: Command): void {
  program
    .command('implement')
    .description('Generate tasks and implement against an approved bundle')
    .argument('<change>', 'the change name to implement (openspec/changes/<change>/)')
    .action(async (change: string) => {
      const root = process.cwd();
      const result = await implement({ root, change, model: implementModel(root) }, liveDeps());

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(result.report) + '\n');
      } else {
        process.stdout.write(result.render + '\n');
        process.stdout.write(`Tasks transcript: ${result.transcriptPaths.tasks}\n`);
        process.stdout.write(`Implement transcript: ${result.transcriptPaths.implement}\n`);
      }

      // A red local-verify verdict exits 1 (architecture.md §2) — a verdict, not
      // an error. The report is already printed; CheckFailure carries the code.
      if (result.report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** Model routing: convenience `models.implement`, else the default (invariant 11
 * — convenience shaping a session, never an enforcement decision). */
function implementModel(root: string): string {
  return loadConvenienceConfig(root).models['implement'] ?? DEFAULT_IMPLEMENT_MODEL;
}

/** The live dependencies for a real implement invocation. */
function liveDeps(): ImplementDeps {
  return {
    substrate: new ClaudeCodeSubstrate(),
    resolve: liveAdapterUnavailable,
    run: liveAdapterUnavailable,
    now: () => new Date().toISOString(),
  };
}

/**
 * The dry-run resolver and oracle runner both spawn the pinned adapter via the
 * P1-11 client, which `init` records in the project config (P2). Until that pin
 * exists, fail closed rather than run the local verify against no adapter.
 */
const liveAdapterUnavailable = ((): never => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves and runs oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then implement runs only via its injectable core (see the P1-16 tracer).',
  );
}) as ResolveFn & ImplementDeps['run'];
