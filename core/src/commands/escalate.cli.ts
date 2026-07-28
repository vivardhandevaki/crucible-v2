// CLI wiring for `crucible escalate` — binds the deterministic core (`escalate`)
// to its non-deterministic edges: the wall-clock, the operator identity, and the
// notify dispatcher. The core stays testable and reproducible (invariant 12); this
// shim supplies the live values at invocation time.
//
// `<change>` is a required argument and `--question` a required option, so a
// missing question is a commander usage error the shared runner maps to exit 2; a
// blank question or no actionable `--option` is caught by the core with the same
// exit. `--option` is repeatable (collected into an array); `--oracle` is optional.
//
// The notify dispatcher is a NO-OP here for now: P2-15 delivers the concrete
// config-driven `notify/` dispatcher and wires it in. Until then escalate still
// writes the load-bearing escalation.yaml (the blocker is the artifact, invariant
// 11) — only the convenience announcement is absent.

import type { Command } from 'commander';
import { escalate, type EscalateDeps } from './escalate.js';

/** Collect a repeatable option into an array (commander accumulator). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Register the real `escalate` subcommand on the program. */
export function registerEscalate(program: Command): void {
  program
    .command('escalate')
    .description('Stop on an ambiguity: file escalation.yaml (halts implement until `amend`)')
    .argument('<change>', 'the change name to escalate (openspec/changes/<change>/)')
    .requiredOption('--question <text>', 'what is underspecified (the human must resolve it)')
    .option(
      '--option <text>',
      'a candidate resolution (repeatable; at least one required)',
      collect,
      [],
    )
    .option('--oracle <id>', 'the oracle the ambiguity concerns, when it maps to one')
    .action(
      async (change: string, opts: { question: string; option: string[]; oracle?: string }) => {
        const result = await escalate(
          {
            root: process.cwd(),
            change,
            question: opts.question,
            options: opts.option,
            ...(opts.oracle !== undefined ? { oracle: opts.oracle } : {}),
          },
          liveDeps(),
        );
        process.stdout.write(`Escalation filed for ${change}: ${result.path}\n`);
        process.stdout.write(`  question: ${result.question}\n`);
        process.stdout.write(
          `  implement is now halted; resolve with \`crucible amend ${change}\` to resume.\n`,
        );
      },
    );
}

/** The live dependencies for a real escalate invocation. */
function liveDeps(): EscalateDeps {
  return {
    now: () => new Date().toISOString(),
    filedBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
    // Convenience notify (invariant 11): a real dispatcher lands in P2-15. A no-op
    // is safe — the escalation.yaml already written is the sole blocker.
    notify: () => {},
  };
}
