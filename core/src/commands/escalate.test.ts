import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { parseEscalation } from '../artifacts/escalation.js';
import { parseState } from '../state/state.js';
import type { NotifyEvent } from '../notify/types.js';
import { escalate, type EscalateDeps } from './escalate.js';

// escalate is the agent's "stop on ambiguity" command (charter §Escalation, layer
// 2; design phase-2.md §3): it writes escalation.yaml, records an audit event, and
// fires the notify hooks — never trusting the notify dispatch to be load-bearing
// (invariant 11: convenience is never enforcement). The clock, identity, and
// notify dispatcher are injected so the core stays deterministic (invariant 12).

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

function makeDeps(over: Partial<EscalateDeps> = {}): {
  deps: EscalateDeps;
  events: NotifyEvent[];
} {
  const events: NotifyEvent[] = [];
  const deps: EscalateDeps = {
    now: () => '2026-07-25T02:00:00Z',
    filedBy: () => 'implement@crucible',
    notify: (event) => {
      events.push(event);
    },
    ...over,
  };
  return { deps, events };
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-escalate-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('escalate — writes escalation.yaml (structural layer, charter)', () => {
  it('writes a valid escalation.yaml into the change bundle', async () => {
    const { deps } = makeDeps();
    const result = await escalate(
      {
        root: scratch,
        change: CHANGE,
        question: 'greeting for an unnamed caller is not specified',
        options: ['reuse the empty-name default', 'error out'],
        oracle: 'ORC-greet-001',
      },
      deps,
    );
    expect(result.path).toBe(join(CHANGE_REL, 'escalation.yaml'));
    const parsed = parseEscalation(readFileSync(join(scratch, result.path), 'utf8'), result.path);
    expect(parsed).toMatchObject({
      change: CHANGE,
      oracle: 'ORC-greet-001',
      question: 'greeting for an unnamed caller is not specified',
      options: ['reuse the empty-name default', 'error out'],
      filed_by: 'implement@crucible',
      filed_at: '2026-07-25T02:00:00Z',
    });
  });

  it('appends a state event recording the escalation (audit trail, invariant 1)', async () => {
    const { deps } = makeDeps();
    await escalate({ root: scratch, change: CHANGE, question: 'q', options: ['a'] }, deps);
    const state = parseState(
      readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8'),
      'state.yaml',
    );
    const event = state.events.find((e) => e.cmd === 'escalate');
    expect(event).toBeDefined();
    expect(state.snapshot.phase).toBe('escalated');
  });

  it('trims the question and drops blank options', async () => {
    const { deps } = makeDeps();
    const result = await escalate(
      { root: scratch, change: CHANGE, question: '  padded  ', options: ['keep', '  ', ''] },
      deps,
    );
    const parsed = parseEscalation(readFileSync(join(scratch, result.path), 'utf8'), result.path);
    expect(parsed.question).toBe('padded');
    expect(parsed.options).toEqual(['keep']);
  });
});

describe('escalate — notify dispatch (convenience, invariant 11)', () => {
  it('invokes the injected notify dispatcher with an escalation event (spy)', async () => {
    const { deps, events } = makeDeps();
    await escalate(
      { root: scratch, change: CHANGE, question: 'ambiguous fee', options: ['a', 'b'] },
      deps,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'escalation', change: CHANGE });
    expect(events[0]!.summary).toContain('ambiguous fee');
  });

  it('a throwing notify hook never blocks the escalation (convenience-never-enforcement)', async () => {
    const { deps } = makeDeps({
      notify: () => {
        throw new Error('webhook down');
      },
    });
    // The artifact is the blocker, not the hook: escalate must still succeed and
    // leave escalation.yaml on disk even when a hook explodes.
    const result = await escalate(
      { root: scratch, change: CHANGE, question: 'q', options: ['a'] },
      deps,
    );
    expect(existsSync(join(scratch, result.path))).toBe(true);
  });

  it('an async-rejecting notify hook is swallowed too', async () => {
    const { deps } = makeDeps({
      notify: () => Promise.reject(new Error('slack timeout')),
    });
    const result = await escalate(
      { root: scratch, change: CHANGE, question: 'q', options: ['a'] },
      deps,
    );
    expect(existsSync(join(scratch, result.path))).toBe(true);
  });
});

describe('escalate — preconditions (exit 2)', () => {
  it('missing change bundle → exit 2 naming propose', async () => {
    const { deps } = makeDeps();
    const err = await catchCrucible(() =>
      escalate({ root: scratch, change: 'no-such', question: 'q', options: ['a'] }, deps),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('an empty question → exit 2, no escalation.yaml written', async () => {
    const { deps } = makeDeps();
    const err = await catchCrucible(() =>
      escalate({ root: scratch, change: CHANGE, question: '   ', options: ['a'] }, deps),
    );
    expect(err.exit).toBe(2);
    expect(existsSync(join(scratch, CHANGE_REL, 'escalation.yaml'))).toBe(false);
  });

  it('no actionable options → exit 2 (an escalation must offer a resolution path)', async () => {
    const { deps } = makeDeps();
    const err = await catchCrucible(() =>
      escalate({ root: scratch, change: CHANGE, question: 'q', options: ['', '  '] }, deps),
    );
    expect(err.exit).toBe(2);
    expect(existsSync(join(scratch, CHANGE_REL, 'escalation.yaml'))).toBe(false);
  });
});
