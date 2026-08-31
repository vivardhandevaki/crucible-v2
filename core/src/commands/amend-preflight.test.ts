import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { preflightAmendment } from './amend-preflight.js';

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const SEALED = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  join('tests', 'greeting.test.ts'),
];

const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map(
      (target): TargetResolution =>
        target.startsWith('greeting::')
          ? { target, status: 'found', targetFile: 'tests/greeting.test.ts' }
          : { target, status: 'missing' },
    ),
  );

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-amend-preflight-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
  const schemaDir = join(root, 'openspec', 'schemas', 'crucible');
  mkdirSync(join(schemaDir, 'templates'), { recursive: true });
  writeFileSync(
    join(schemaDir, 'schema.yaml'),
    [
      'name: crucible',
      'version: 1',
      'description: test schema',
      'artifacts:',
      '  - id: proposal',
      '    generates: proposal.md',
      '    description: proposal',
      '    template: proposal.md',
      '  - id: specs',
      "    generates: 'specs/**/*.md'",
      '    description: specs',
      '    template: spec.md',
      '  - id: design',
      '    generates: design.md',
      '    description: design',
      '    template: design.md',
      '  - id: oracles',
      '    generates: oracles.md',
      '    description: oracles',
      '    template: oracles.md',
      '  - id: tasks',
      '    generates: tasks.md',
      '    description: tasks',
      '    template: tasks.md',
      'apply:',
      '  requires: [tasks]',
      '  tracks: tasks.md',
    ].join('\n'),
  );
  for (const template of ['proposal.md', 'spec.md', 'design.md', 'oracles.md', 'tasks.md']) {
    writeFileSync(join(schemaDir, 'templates', template), 'template\n');
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seal(): void {
  writeFileSync(
    join(root, CHANGE_REL, 'approval.yaml'),
    serializeApproval(
      sealBundle(root, SEALED, {
        version: 1,
        change: CHANGE,
        approved_by: 'ada@example.com',
        approved_at: '2026-08-31T00:00:00Z',
      }),
    ),
  );
}

async function thrown(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (error) {
    if (isCrucibleError(error)) return error;
    throw error;
  }
  throw new Error('expected a CrucibleError');
}

describe('P4R-06 amendment preflight', () => {
  it('does not require an amendment for ordinary implementation code changes', async () => {
    seal();
    writeFileSync(join(root, 'src', 'greeting.ts'), 'export const greeting = "Hello";\n');

    const result = await preflightAmendment({ root, change: CHANGE }, { resolve: resolveAllFound });

    expect(result.phase).toBe('no-amendment-needed');
    expect(result.instruction).toContain(`crucible verify ${CHANGE}`);
  });

  it('validates the complete dependent bundle after a sealed intent edit', async () => {
    seal();
    writeFileSync(join(root, CHANGE_REL, 'design.md'), '# Design\n\nAmended promise.\n');

    const result = await preflightAmendment({ root, change: CHANGE }, { resolve: resolveAllFound });

    expect(result.phase).toBe('ready-for-reseal');
    expect(result.report?.verdict).toBe('pass');
    expect(result.instruction).toBe(`Ask a human to run \`crucible approve --amend ${CHANGE}\` in a terminal.`);
  });

  it('keeps an invalid dependent artifact blocked and names the revise step', async () => {
    seal();
    writeFileSync(join(root, CHANGE_REL, 'design.md'), '');

    const result = await preflightAmendment({ root, change: CHANGE }, { resolve: resolveAllFound });

    expect(result.phase).toBe('revise');
    expect(result.report?.verdict).toBe('fail');
    expect(result.instruction).toContain(`crucible amend ${CHANGE}`);
  });

  it('refuses an amendment before a human approval exists', async () => {
    const error = await thrown(() =>
      preflightAmendment({ root, change: CHANGE }, { resolve: resolveAllFound }),
    );

    expect(error.exit).toBe(2);
    expect(error.hint).toContain(`crucible approve ${CHANGE}`);
  });
});
