import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { preflightImplementation } from './implement-preflight.js';

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const SEALED = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  join('tests', 'greeting.test.ts'),
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-implement-preflight-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
  rmSync(join(root, CHANGE_REL, 'tasks.md'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seal(): void {
  const approval = sealBundle(root, SEALED, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: '2026-08-31T00:00:00Z',
  });
  writeFileSync(join(root, CHANGE_REL, 'approval.yaml'), serializeApproval(approval));
}

async function thrown(fn: () => unknown): Promise<CrucibleError> {
  try {
    await fn();
  } catch (error) {
    if (isCrucibleError(error)) return error;
    throw error;
  }
  throw new Error('expected a CrucibleError');
}

describe('P4R-05 implement preflight', () => {
  it('blocks before emitting implementation instructions when approval is missing', async () => {
    const error = await thrown(() => preflightImplementation({ root, change: CHANGE }));

    expect(error.exit).toBe(2);
    expect(error.hint).toContain(`crucible approve ${CHANGE}`);
  });

  it('blocks a void seal before emitting implementation instructions', async () => {
    seal();
    writeFileSync(join(root, 'tests', 'greeting.test.ts'), '// sealed oracle test changed\n');

    const error = await thrown(() => preflightImplementation({ root, change: CHANGE }));

    expect(error.exit).toBe(2);
    expect(error.message).toContain(join('tests', 'greeting.test.ts'));
  });

  it('directs the active session to author post-approval tasks.md before code', () => {
    seal();

    expect(preflightImplementation({ root, change: CHANGE })).toEqual({
      action: 'implement',
      change: CHANGE,
      phase: 'approved',
      instruction:
        `Approval is current. First author ${join(CHANGE_REL, 'tasks.md')}; then implement code and ordinary tests. ` +
        `Do not edit sealed artifacts or bound oracle tests. Run \`crucible verify ${CHANGE}\` after each change.`,
    });
  });
});
