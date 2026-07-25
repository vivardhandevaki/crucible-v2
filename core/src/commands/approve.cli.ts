// CLI wiring for `crucible approve` — binds the deterministic core (`approve`)
// to the real, non-deterministic edges (terminal prompt, wall-clock, git
// identity, adapter resolver). The core stays testable and reproducible
// (invariant 12); this file is the thin shim that supplies the live
// dependencies at command-invocation time.
//
// The binding resolver is the one edge that is genuinely blocked: it must spawn
// the pinned adapter process, which is the P1-11 adapter client. Until that
// lands, the shim fails closed (invariant 3) with a message naming the missing
// piece rather than pretending the gate ran. The `approve` core itself is
// complete and directly tested (approve.test.ts).

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { approve, type ApproveDeps } from './approve.js';
import type { ResolveFn } from '../lint/traceability.js';
import { preconditionError } from '../util/errors.js';

/** Register the real `approve` subcommand on the program. */
export function registerApprove(program: Command): void {
  program
    .command('approve')
    .description('Seal an approved bundle by hashing its artifacts')
    .argument('<change>', 'the change name to approve (openspec/changes/<change>/)')
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .option(
      '--confirm-consistency',
      'seal despite a staleness warning (you have checked the hand-edits are coherent)',
      false,
    )
    .action(async (change: string, opts: { yes?: boolean; confirmConsistency?: boolean }) => {
      const result = await approve(
        {
          root: process.cwd(),
          change,
          yes: opts.yes === true,
          confirmConsistency: opts.confirmConsistency === true,
        },
        liveDeps(),
      );
      process.stdout.write(result.render + '\n');
      if (result.approved) {
        process.stdout.write(
          `Approved ${change}: ${result.sealedFiles?.length ?? 0} file(s) sealed.\n`,
        );
      } else {
        process.stdout.write(`Not approved: ${change} left unsealed.\n`);
      }
    });
}

/** The live dependencies for a real approve invocation. */
function liveDeps(): ApproveDeps {
  return {
    resolve: liveResolve,
    confirm: promptConfirm,
    now: () => new Date().toISOString(),
    approvedBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
  };
}

/**
 * The binding resolver spawns the pinned adapter (P1-11 adapter client). Until
 * that exists, fail closed rather than run the gate against no resolver.
 */
const liveResolve: ResolveFn = () => {
  throw preconditionError(
    'NO_ADAPTER_CLIENT',
    'The adapter client that resolves oracle bindings is not wired yet.',
    'This lands in P1-11 (adapter client); until then approve runs only via its injectable core.',
  );
};

/** Interactive y/N confirmation on stdin/stdout. Empty / non-y → decline. */
async function promptConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Seal this approval? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
