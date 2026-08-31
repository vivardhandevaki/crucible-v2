import type { Command } from 'commander';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { CheckFailure, preconditionError } from '../util/errors.js';
import { renderReport } from '../verifyx/report.js';
import { validateProposalBundle } from './bundle.js';
import { preflightImplementation } from './implement-preflight.js';
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
    .action(async (change: string) => writeProposalInstructions(program, change));
  program
    .command('implement')
    .description('Preflight the current seal and show active-session implementation instructions')
    .argument('<change>', 'the approved change name')
    .action((change: string) => writeImplementationInstructions(program, change));
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

/** P4R-05: never issue code-authoring instructions before a current human seal. */
function writeImplementationInstructions(program: Command, change: string): void {
  const preflight = preflightImplementation({ root: process.cwd(), change });
  if (program.opts().json === true) process.stdout.write(JSON.stringify(preflight) + '\n');
  else process.stdout.write(`${preflight.instruction}\n`);
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

/**
 * P4R-03: after the active session authors its files, `propose` judges the
 * schema-complete proposal and real adapter-grounded tests. It never asks where
 * a test may be created; that choice belongs to the agent and is validated only
 * after the fact by resolve.
 */
async function writeProposalInstructions(program: Command, change: string): Promise<void> {
  const root = process.cwd();
  const current = status({ root, change }, { readMergeBaseConfig: () => undefined });
  if (current.phase === 'absent') {
    writeInstructions(program, change, 'propose');
    return;
  }
  if (current.phase !== 'proposed') {
    throw preconditionError(
      'PROPOSAL_ALREADY_ADVANCED',
      `Change ${change} is ${current.phase}; proposal authoring is only available before approval.`,
      current.next,
    );
  }

  const adapter = loadPinnedAdapterClient(root);
  const result = await validateProposalBundle(
    { root, change },
    { resolve: (targets) => adapter.resolve(targets) },
  );
  if (program.opts().json === true) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stdout.write(`${renderReport(result.report)}\n${result.reviseInstruction}\n`);
  if (result.report.verdict === 'fail') throw new CheckFailure();
}
