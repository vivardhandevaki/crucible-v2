import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { parseOverride } from '../artifacts/override.js';
import { parseState } from '../state/state.js';
import { override, type OverrideDeps } from './override.js';

// override records a gate bypass HONESTLY (charter §Override; design §3): it writes
// override.yaml + a state event, refuses without a bundle or a reason (exit 2), and
// stays deterministic (invariant 12) — the clock and identity are injected.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);

const DEPS: OverrideDeps = {
  now: () => '2026-07-25T02:00:00Z',
  overriddenBy: () => 'ada@example.com',
};

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-override-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('override — happy path', () => {
  it('writes a valid override.yaml into the change bundle', () => {
    const result = override({ root: scratch, change: CHANGE, reason: '2am prod fix' }, DEPS);
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

  it('trims the reason before recording it', () => {
    const result = override({ root: scratch, change: CHANGE, reason: '  padded  ' }, DEPS);
    expect(result.reason).toBe('padded');
    const parsed = parseOverride(readFileSync(join(scratch, result.path), 'utf8'), result.path);
    expect(parsed.reason).toBe('padded');
  });

  it('appends a state event recording the bypass (audit trail, invariant 1)', () => {
    override({ root: scratch, change: CHANGE, reason: 'incident-1234' }, DEPS);
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

describe('override — preconditions (exit 2)', () => {
  it('missing change bundle → exit 2 naming propose', () => {
    const err = catchCrucible(() =>
      override({ root: scratch, change: 'no-such-change', reason: 'x' }, DEPS),
    );
    expect(err.exit).toBe(2);
    expect(err.hint.toLowerCase()).toContain('propose');
  });

  it('an empty reason → exit 2 (a reasonless bypass defeats the loudness contract)', () => {
    const err = catchCrucible(() => override({ root: scratch, change: CHANGE, reason: '' }, DEPS));
    expect(err.exit).toBe(2);
    // No override.yaml is written when refused.
    expect(existsSync(join(scratch, CHANGE_REL, 'override.yaml'))).toBe(false);
  });

  it('a whitespace-only reason → exit 2', () => {
    const err = catchCrucible(() =>
      override({ root: scratch, change: CHANGE, reason: '   ' }, DEPS),
    );
    expect(err.exit).toBe(2);
  });
});
