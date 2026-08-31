import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { validateProposalBundle } from './bundle.js';

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-proposal-validation-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  const schemaDir = join(scratch, 'openspec', 'schemas', 'crucible');
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
      '  - id: decisions',
      '    generates: decisions.md',
      '    description: custom approval artifact',
      '    template: decisions.md',
      '  - id: tasks',
      '    generates: tasks.md',
      '    description: post approval tasks',
      '    template: tasks.md',
      'apply:',
      '  requires: [tasks]',
      '  tracks: tasks.md',
    ].join('\n'),
  );
  for (const name of [
    'proposal.md',
    'spec.md',
    'design.md',
    'oracles.md',
    'decisions.md',
    'tasks.md',
  ]) {
    writeFileSync(join(schemaDir, 'templates', name), 'template\n');
  }
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const resolveFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => ({
      target,
      status: 'found',
      targetFile: 'tests/greeting.test.ts',
    })),
  );

describe('validateProposalBundle — P4R-03 proposal boundary', () => {
  it('accepts all schema-declared pre-approval artifacts and reports their seal candidates', async () => {
    writeFileSync(join(scratch, CHANGE_REL, 'decisions.md'), '# Decisions\n\nUse a greeting.\n');
    rmSync(join(scratch, CHANGE_REL, 'tasks.md'));

    const result = await validateProposalBundle(
      { root: scratch, change: CHANGE },
      { resolve: resolveFound },
    );

    expect(result.report.verdict).toBe('pass');
    expect(result.phase).toBe('ready-for-approval');
    expect(result.approvalCandidates).toContain(join(CHANGE_REL, 'decisions.md'));
    expect(result.approvalCandidates).toContain('tests/greeting.test.ts');
    expect(result.approvalCandidates).not.toContain(join(CHANGE_REL, 'tasks.md'));
  });

  it('rejects a missing schema-declared custom artifact with a revise instruction', async () => {
    rmSync(join(scratch, CHANGE_REL, 'tasks.md'));

    const result = await validateProposalBundle(
      { root: scratch, change: CHANGE },
      { resolve: resolveFound },
    );

    expect(result.report.verdict).toBe('fail');
    expect(result.reviseInstruction).toContain('decisions.md');
  });

  it('rejects tasks.md before approval', async () => {
    writeFileSync(join(scratch, CHANGE_REL, 'decisions.md'), '# Decisions\n');

    const result = await validateProposalBundle(
      { root: scratch, change: CHANGE },
      { resolve: resolveFound },
    );

    expect(result.report.verdict).toBe('fail');
    expect(result.reviseInstruction).toContain('tasks.md');
  });

  it('rejects an outside-root grounded test file', async () => {
    writeFileSync(join(scratch, CHANGE_REL, 'decisions.md'), '# Decisions\n');
    rmSync(join(scratch, CHANGE_REL, 'tasks.md'));
    const outside: ResolveFn = (targets) =>
      Promise.resolve(
        targets.map((target): TargetResolution => ({
          target,
          status: 'found',
          targetFile: '../escape.test.ts',
        })),
      );

    const result = await validateProposalBundle(
      { root: scratch, change: CHANGE },
      { resolve: outside },
    );

    expect(result.report.verdict).toBe('fail');
    expect(result.reviseInstruction).toContain('contained');
  });
});
