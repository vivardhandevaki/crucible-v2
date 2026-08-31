import type { Command } from 'commander';
import { preconditionError } from '../util/errors.js';
import { renderStatus, status } from './status.js';

/**
 * P4R-02 command boundary: these commands never author files or launch an
 * agent. They expose deterministic instructions to the already-active session.
 * Proposal semantics and post-approval task authoring deliberately land in their
 * separately scoped successor tasks.
 */
export function registerActiveSessionCommands(program: Command): void {
  program
    .command('propose')
    .description('Show artifact-derived proposal scaffold instructions')
    .argument('<change>', 'the change name')
    .action((change: string) => writeInstructions(program, change, 'propose'));
  program
    .command('implement')
    .description('Show artifact-derived implementation instructions')
    .argument('<change>', 'the approved change name')
    .action((change: string) => writeInstructions(program, change, 'implement'));
  program
    .command('amend')
    .description('Intent amendment is unavailable until P4R-06')
    .argument('<change>', 'the approved change name')
    .action((change: string) => {
      throw preconditionError(
        'AMEND_NOT_AVAILABLE',
        `Intent amendment for ${change} is not available in the thin lifecycle scaffold.`,
        'Run `crucible status <change>`; P4R-06 adds amendment and human re-sealing.',
      );
    });
}

function writeInstructions(
  program: Command,
  change: string,
  action: 'propose' | 'implement',
): void {
  const report = status({ root: process.cwd(), change }, { readMergeBaseConfig: () => undefined });
  const instructions = {
    action,
    change,
    phase: report.phase,
    next: report.next,
    instruction:
      action === 'propose'
        ? 'Author only the CLI-requested artifacts in this active session, then run status again.'
        : 'Confirm the current seal and follow the CLI-returned implementation preflight in this active session.',
  };
  if (program.opts().json === true) process.stdout.write(JSON.stringify(instructions) + '\n');
  else process.stdout.write(`${renderStatus(report)}\n${instructions.instruction}\n`);
}
