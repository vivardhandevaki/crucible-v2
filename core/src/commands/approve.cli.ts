// Human-only terminal wiring for the approval gate.  This is deliberately not
// part of the generated active-session command surface: only an operator at a
// terminal can confirm (or explicitly opt into the auditable batch form).

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { preconditionError } from '../util/errors.js';
import { approve, type ApproveDeps } from './approve.js';

interface CliOptions {
  yes?: boolean;
  approvedBy?: string;
  amend?: boolean;
}

export function registerApprove(program: Command): void {
  program
    .command('approve')
    .description('Render and human-seal a schema-complete proposal bundle')
    .argument('<change>', 'the proposal change name')
    .option('--amend', 'append a human-reviewed amendment generation to an existing approval')
    .option('--yes', 'non-interactively seal; requires --approved-by')
    .requiredOption('--approved-by <identity>', 'reviewer identity when using --yes')
    .action(async (change: string, options: CliOptions) => {
      // Commander enforces identity for both paths; an interactive approval is
      // still an attributable human act, never an anonymous agent action.
      const root = process.cwd();
      const adapter = loadPinnedAdapterClient(root);
      const result = await approve(
        {
          root,
          change,
          yes: options.yes === true,
          amend: options.amend === true,
          requireSchema: true,
          width: process.stdout.columns ?? 80,
          color: false,
        },
        terminalDeps(options.approvedBy!, adapter.resolve.bind(adapter)),
      );
      process.stdout.write(result.render + '\n');
      if (result.approved)
        process.stdout.write(
          `Approved ${change}; sealed ${result.sealedFiles?.length ?? 0} files.\n`,
        );
      else process.stdout.write(`Approval declined; nothing was written.\n`);
    });
}

function terminalDeps(approvedBy: string, resolve: ApproveDeps['resolve']): ApproveDeps {
  return {
    resolve,
    approvedBy: () => approvedBy,
    now: () => new Date().toISOString(),
    pager: (text) => {
      process.stdout.write(text + '\n');
    },
    walk: async () =>
      (await ask('Review this oracle. Press Enter to continue, or q to decline: '))
        .trim()
        .toLowerCase() === 'q'
        ? 'quit'
        : 'next',
    confirm: async () => /^y(es)?$/i.test((await ask('Seal this reviewed bundle? [y/N] ')).trim()),
    // P4R intentionally has no in-gate agent regeneration path.  A material
    // edit must return to the active-session propose validator before review.
    openEditor: async () => {
      throw preconditionError(
        'APPROVE_EDIT_UNAVAILABLE',
        'Inline approval edits are unavailable in the thin lifecycle.',
        'Decline, revise the proposal in the active session, and re-run `crucible approve`.',
      );
    },
    confirmDiff: async () => 'quit',
  };
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
