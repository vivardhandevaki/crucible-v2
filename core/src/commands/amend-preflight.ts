// P4R amendment boundary: active sessions can revise intent and oracle inputs,
// but only a human terminal approval can append a new seal generation.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import type { ResolveFn } from '../lint/traceability.js';
import { preconditionError } from '../util/errors.js';
import type { VerifyReport } from '../verifyx/report.js';
import { validateProposalBundle } from './bundle.js';

export interface AmendmentPreflight {
  action: 'amend';
  change: string;
  phase: 'ready-for-reseal' | 'revise' | 'no-amendment-needed';
  instruction: string;
  report?: VerifyReport;
}

/** Validate a post-approval edit without writing approval evidence. */
export async function preflightAmendment(
  options: { root: string; change: string },
  deps: { resolve: ResolveFn },
): Promise<AmendmentPreflight> {
  const changeRel = join('openspec', 'changes', options.change);
  const changeDir = join(options.root, changeRel);
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${options.change} "<intent>"\` to scaffold the bundle first.`,
    );
  }
  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'NO_APPROVAL',
      `Cannot amend ${options.change}: no approval.yaml exists in ${changeRel}.`,
      `Run \`crucible approve ${options.change}\` before changing approved intent or oracle inputs.`,
    );
  }

  if (verifyApproval(options.root, loadApproval(approvalPath)).valid) {
    return {
      action: 'amend',
      change: options.change,
      phase: 'no-amendment-needed',
      instruction:
        `Approval is current. Ordinary implementation code and non-bound test fixes need no amendment; run \`crucible verify ${options.change}\`. ` +
        `To change approved intent or oracle inputs, revise them in this active session, then run \`crucible amend ${options.change}\` again.`,
    };
  }

  const validation = await validateProposalBundle(
    { root: options.root, change: options.change, allowPostApprovalArtifacts: true },
    deps,
  );
  if (validation.phase === 'ready-for-approval') {
    return {
      action: 'amend',
      change: options.change,
      phase: 'ready-for-reseal',
      report: validation.report,
      instruction: `Ask a human to run \`crucible approve --amend ${options.change}\` in a terminal.`,
    };
  }
  return {
    action: 'amend',
    change: options.change,
    phase: 'revise',
    report: validation.report,
    instruction:
      `Revise the complete dependent intent/oracle bundle in this active session, then re-run \`crucible amend ${options.change}\`.`,
  };
}
