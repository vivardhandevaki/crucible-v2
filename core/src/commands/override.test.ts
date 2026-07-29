import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { parseOverride } from '../artifacts/override.js';
import { parseState } from '../state/state.js';
import type { NotifyEvent } from '../notify/types.js';
import { override, type OverrideDeps } from './override.js';

// override records a gate bypass HONESTLY (charter §Override; design §3): it writes
// override.yaml + a state event, fires the notify hooks (never load-bearing —
// invariant 11), refuses without a bundle or a reason (exit 2), and stays
// deterministic (invariant 12) — the clock, identity, and notify are injected.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

function makeDeps(over: Partial<OverrideDeps> = {}): {
  deps: OverrideDeps;
  events: NotifyEvent[];
} {
  const events: NotifyEvent[] = [];
  const deps: OverrideDeps = {
    now: () => '2026-07-25T02:00:00Z',
    overriddenBy: () => 'ada@example.com',
    notify: (event) => {
      events.push(event);
    },
    ...over,
  };
  return { deps, events };
}

const DEPS = makeDeps().deps;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-override-'));
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

describe('override — happy path', () => {
  it('writes a valid override.yaml into the change bundle', async () => {
    const result = await override({ root: scratch, change: CHANGE, reason: '2am prod fix' }, DEPS);
    expect(result.path).toBe(join(CHANGE_REL, 'override.yaml'));
    const text = readFileSync(join(scratch, result.path), 'utf8');
    const parsed = parseOverride(text, result.path);
    expect(parsed).toMatchObject({
      change: CHANGE,
      reason: '2am prod fix',
      created_by: 'ada@example.com',
      created_at: '2026-07-25T02:00:00Z',
    });
  });

  it('trims the reason before recording it', async () => {
    const result = await override({ root: scratch, change: CHANGE, reason: '  padded  ' }, DEPS);
    expect(result.reason).toBe('padded');
    const parsed = parseOverride(readFileSync(join(scratch, result.path), 'utf8'), result.path);
    expect(parsed.reason).toBe('padded');
  });

  it('appends a state event recording the bypass (audit trail, invariant 1)', async () => {
    await override({ root: scratch, change: CHANGE, reason: 'incident-1234' }, DEPS);
    const state = parseState(
      readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8'),
      'state.yaml',
    );
    const event = state.events.find((e) => e.cmd === 'override');
    expect(event).toBeDefined();
    expect(event?.summary).toContain('incident-1234');
    expect(state.snapshot.phase).toBe('overridden');
  });
});

describe('override — notify dispatch (convenience, invariant 11)', () => {
  it('invokes the injected notify dispatcher with an override event (spy)', async () => {
    const { deps, events } = makeDeps();
    await override({ root: scratch, change: CHANGE, reason: 'incident-1234' }, deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'override', change: CHANGE });
    expect(events[0]!.summary).toContain('incident-1234');
  });

  it('a throwing notify hook never blocks the override (convenience-never-enforcement)', async () => {
    const { deps } = makeDeps({
      notify: () => {
        throw new Error('webhook down');
      },
    });
    const result = await override({ root: scratch, change: CHANGE, reason: 'incident-1234' }, deps);
    // The override.yaml is the blocker, not the hook — it must be on disk.
    expect(existsSync(join(scratch, result.path))).toBe(true);
  });

  it('an async-rejecting notify hook is swallowed too', async () => {
    const { deps } = makeDeps({
      notify: () => Promise.reject(new Error('slack timeout')),
    });
    const result = await override({ root: scratch, change: CHANGE, reason: 'incident-1234' }, deps);
    expect(existsSync(join(scratch, result.path))).toBe(true);
  });
});

describe('override — preconditions (exit 2)', () => {
  it('missing change bundle → exit 2 naming propose', async () => {
    const err = await catchCrucible(() =>
      override({ root: scratch, change: 'no-such-change', reason: 'x' }, DEPS),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('an empty reason → exit 2 (a reasonless bypass defeats the loudness contract)', async () => {
    const err = await catchCrucible(() =>
      override({ root: scratch, change: CHANGE, reason: '' }, DEPS),
    );
    expect(err.exit).toBe(2);
    // No override.yaml is written when refused.
    expect(existsSync(join(scratch, CHANGE_REL, 'override.yaml'))).toBe(false);
  });

  it('a whitespace-only reason → exit 2', async () => {
    const err = await catchCrucible(() =>
      override({ root: scratch, change: CHANGE, reason: '   ' }, DEPS),
    );
    expect(err.exit).toBe(2);
  });
});
