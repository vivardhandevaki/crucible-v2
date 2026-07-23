// CLI wiring for `crucible verify` — binds the deterministic core (`verify`) to
// the real, non-deterministic edges (the adapter client's dry-run resolver and
// oracle runner) and prints the report. The core stays testable and reproducible
// (invariant 12); this file is the thin shim that supplies live dependencies at
// invocation time and maps the verdict to the process exit code.
//
// A red verdict is signaled with `CheckFailure` (exit 1) AFTER the report is
// rendered — so `--json` writes the report to stdout, not an error object. A
// genuine error (missing bundle, malformed artifact, broken adapter) still throws
// a `CrucibleError` (exit 2/3) from the core and is handled by the runner.
//
// The live resolver/runner must spawn the pinned adapter, which `init` records
// (P2). Until then the shim fails closed (invariant 3) with a message naming the
// missing piece rather than pretending the checks ran. The `verify` core itself
// is complete and directly tested (verify.test.ts); the tracer (P1-16) wires a
// real stub-adapter client into these deps.

import type { Command } from 'commander';
import { verify, type VerifyDeps } from './verify.js';
import { renderReport } from '../verifyx/report.js';
import { CheckFailure, preconditionError } from '../util/errors.js';

/** Register the real `verify` subcommand on the program. */
export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('Run lint, oracles, and hash checks; report green/red')
    .argument('<change>', 'the change name to verify (openspec/changes/<change>/)')
    .action(async (change: string) => {
      const report = await verify({ root: process.cwd(), change }, liveDeps());

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        process.stdout.write(renderReport(report) + '\n');
      }

      // A red verdict exits 1 (architecture.md §2) — a verdict, not an error. The
      // report is already printed; CheckFailure carries the exit code silently.
      if (report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** The live dependencies for a real verify invocation. */
function liveDeps(): VerifyDeps {
  return { resolve: liveAdapterUnavailable, run: liveAdapterUnavailable };
}

/**
 * The dry-run resolver and oracle runner both spawn the pinned adapter via the
 * P1-11 client, which `init` records in the project config (P2). Until that pin
 * exists, fail closed rather than run the checks against no adapter.
 */
const liveAdapterUnavailable = (): never => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves and runs oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then verify runs only via its injectable core (see the P1-16 tracer).',
  );
};
