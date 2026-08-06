import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import type { Oracle } from '../artifacts/oracles.js';
import type { OracleResult } from '../adapters/types.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { isCrucibleError, type CrucibleError } from '../util/errors.js';
import {
  implementFinish,
  implementStart,
  implementTasksReady,
  proposeFinish,
  proposeNext,
  proposeStart,
  type SessionDeps,
} from './session.js';

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const FROZEN_NOW = '2026-08-03T00:00:00Z';
const TARGET_FILES: Record<string, string> = {
  'greeting::returns_hello_for_a_name': 'tests/greeting.test.ts',
  'greeting::defaults_to_world_when_empty': 'tests/greeting.test.ts',
};
const SEALED_SCOPE = [
  join(CHANGE_REL, 'proposal.md'),
  join(CHANGE_REL, 'design.md'),
  join(CHANGE_REL, 'oracles.md'),
  join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  join('tests', 'greeting.test.ts'),
];

const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => {
      const targetFile = TARGET_FILES[target];
      return targetFile ? { target, status: 'found', targetFile } : { target, status: 'missing' };
    }),
  );

const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((oracle) => ({
      oracleId: oracle.id,
      requirement: oracle.binding.requirement,
      status: 'pass' as const,
      targets: oracle.binding.targets.map((target) => ({ target, status: 'pass' as const })),
    })),
  );

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-session-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  rmSync(join(scratch, CHANGE_REL), { recursive: true });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function deps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    now: () => FROZEN_NOW,
    scaffold: async (change, schema) => {
      const source = join(TOY_REPO_ROOT, CHANGE_REL);
      const destination = join(scratch, 'openspec', 'changes', change);
      cpSync(source, destination, { recursive: true });
      rmSync(join(destination, 'tasks.md'), { force: true });
      writeFileSync(join(destination, '.openspec.yaml'), `schema: ${schema}\n`);
    },
    instructions: async () => [
      { path: join(CHANGE_REL, 'proposal.md'), content: 'Write the proposal artifact.' },
    ],
    resolve: resolveAllFound,
    run: runAllPass,
    ...overrides,
  };
}

function sealApproval(): void {
  const approval = sealBundle(scratch, SEALED_SCOPE, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: FROZEN_NOW,
  });
  writeFileSync(join(scratch, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}

async function capture(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (error) {
    if (isCrucibleError(error)) return error;
    throw error;
  }
  throw new Error('expected a CrucibleError');
}

describe('session-native propose — CLI-owned lifecycle', () => {
  it('scaffolds through the supplied runtime, records no agent transcript, and returns strict next instructions', async () => {
    const start = await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    expect(start.role).toBe('propose');
    expect(start.next_command).toBe(`crucible session propose next ${CHANGE}`);
    expect(start.instructions).toEqual([]);
    expect(existsSync(join(scratch, '.crucible', 'sessions', CHANGE, 'propose.json'))).toBe(true);

    const next = await proposeNext({ root: scratch, change: CHANGE }, deps());
    expect(next.instructions[0]?.path).toBe(join(CHANGE_REL, 'proposal.md'));
    expect(next.next_command).toBe(`crucible session propose finish ${CHANGE}`);
  });

  it('does not trust a checkpoint or a conversation result: malformed checkpoint fails closed', async () => {
    await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    writeFileSync(join(scratch, '.crucible', 'sessions', CHANGE, 'propose.json'), '{ bad json');
    const error = await capture(() => proposeNext({ root: scratch, change: CHANGE }, deps()));
    expect(error.exit).toBe(3);
    expect(error.code).toBe('INVALID_SESSION_CHECKPOINT');
  });

  it('keeps an interrupted proposal resumable and judges malformed authored artifacts as a red result', async () => {
    await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    const result = await proposeFinish({ root: scratch, change: CHANGE }, deps());
    expect(result.report.verdict).toBe('pass');
    expect(readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8')).toContain(
      'session-native',
    );
  });
});

describe('session-native propose — oracle handoff (P4-11)', () => {
  it('suppresses OpenSpec tasks and returns an exact missing-oracle test handoff', async () => {
    await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    const next = await proposeNext(
      { root: scratch, change: CHANGE },
      deps({
        instructions: async () => [{ path: join(CHANGE_REL, 'tasks.md'), content: 'Tasks.' }],
        resolve: (targets) =>
          Promise.resolve(
            targets.map((target): TargetResolution =>
              target === 'greeting::returns_hello_for_a_name'
                ? {
                    target,
                    status: 'missing',
                    candidateFile: 'src/test/java/com/acme/GreetingControllerTest.java',
                  }
                : { target, status: 'found', targetFile: TARGET_FILES[target]! },
            ),
          ),
      }),
    );
    expect(next.stage).toBe('oracle-tests');
    expect(next.instructions[0]?.path).toBe('src/test/java/com/acme/GreetingControllerTest.java');
    expect(next.next_command).toBe('crucible session propose next ' + CHANGE);
  });

  it('cannot judge a pre-approval tasks.md as a valid proposal', async () => {
    await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    writeFileSync(join(scratch, CHANGE_REL, 'tasks.md'), '# Tasks\n');
    const result = await proposeFinish({ root: scratch, change: CHANGE }, deps());
    expect(result.report.verdict).toBe('fail');
  });
  it('migrates a legacy authoring checkpoint by artifact re-derivation', async () => {
    await proposeStart(
      { root: scratch, change: CHANGE, intent: 'Add a greeting.', type: 'feature' },
      deps(),
    );
    const path = join(scratch, '.crucible', 'sessions', CHANGE, 'propose.json');
    const checkpoint = JSON.parse(readFileSync(path, 'utf8')) as { stage: string };
    checkpoint.stage = 'authoring';
    writeFileSync(path, JSON.stringify(checkpoint));
    const next = await proposeNext({ root: scratch, change: CHANGE }, deps());
    expect(next.stage).toBe('artifacts');
  });
});

describe('session-native implement — approval-bound lifecycle', () => {
  beforeEach(() => {
    cpSync(join(TOY_REPO_ROOT, CHANGE_REL), join(scratch, CHANGE_REL), { recursive: true });
  });

  it('refuses to start without an approval and makes tasks a separate stage', async () => {
    const noApproval = await capture(() => implementStart({ root: scratch, change: CHANGE }));
    expect(noApproval.exit).toBe(2);
    expect(noApproval.hint).toContain(`crucible approve ${CHANGE}`);

    sealApproval();
    const start = await implementStart({ root: scratch, change: CHANGE });
    expect(start.stage).toBe('tasks');
    expect(start.next_command).toBe(`crucible session implement tasks-ready ${CHANGE}`);
  });

  it('rejects an empty tasks file and verifies only after the implementation stage', async () => {
    sealApproval();
    await implementStart({ root: scratch, change: CHANGE });
    writeFileSync(join(scratch, CHANGE_REL, 'tasks.md'), '');
    const noTasks = await capture(() => implementTasksReady({ root: scratch, change: CHANGE }));
    expect(noTasks.exit).toBe(2);

    writeFileSync(join(scratch, CHANGE_REL, 'tasks.md'), '# Tasks\n\n- [ ] Implement greeting\n');
    const implementation = await implementTasksReady({ root: scratch, change: CHANGE });
    expect(implementation.stage).toBe('implementation');
    const result = await implementFinish({ root: scratch, change: CHANGE }, deps());
    expect(result.report.verdict).toBe('pass');
    expect(readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8')).toContain(
      'session-native',
    );
  });
});
