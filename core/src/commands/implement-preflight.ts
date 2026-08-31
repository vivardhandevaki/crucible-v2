// The P4R implementation boundary. This command deliberately does not author
// tasks or launch an agent: it only proves that the human seal still holds, then
// returns the next active-session instruction.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { preconditionError } from '../util/errors.js';

export interface ImplementationPreflight {
  action: 'implement';
  change: string;
  phase: 'approved' | 'implemented';
  instruction: string;
}

/**
 * Refuse before issuing any implementation guidance unless the human approval
 * exists and every sealed byte remains current. `tasks.md` is intentionally
 * outside the seal: it is the first post-approval artifact the active session
 * writes, before implementation code and ordinary tests.
 */
export function preflightImplementation(options: {
  root: string;
  change: string;
}): ImplementationPreflight {
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
      `Cannot implement ${options.change}: no approval.yaml exists in ${changeRel}.`,
      `Run \`crucible approve ${options.change}\` to seal the reviewed bundle before implementing.`,
    );
  }
  const approval = loadApproval(approvalPath);
  const verdict = verifyApproval(options.root, approval);
  if (!verdict.valid) {
    throw preconditionError(
      'APPROVAL_VOID',
      `Cannot implement ${options.change}: the approval is void — these sealed files changed or went missing since approval:\n${verdict.mismatches
        .map((path) => `  ✗ ${path}`)
        .join('\n')}`,
      `Run \`crucible amend ${options.change}\` when intent or oracle bytes changed; otherwise restore the sealed bytes, then run \`crucible implement ${options.change}\`.`,
    );
  }

  const tasksRel = join(changeRel, 'tasks.md');
  const hasTasks =
    existsSync(join(changeDir, 'tasks.md')) && statSync(join(changeDir, 'tasks.md')).size > 0;
  return {
    action: 'implement',
    change: options.change,
    phase: hasTasks ? 'implemented' : 'approved',
    instruction: hasTasks
      ? `Approval is current. Continue implementation code and ordinary tests without editing sealed artifacts or bound oracle tests. Run \`crucible verify ${options.change}\` after each change.`
      : `Approval is current. First author ${tasksRel}; then implement code and ordinary tests. Do not edit sealed artifacts or bound oracle tests. Run \`crucible verify ${options.change}\` after each change.`,
  };
}
