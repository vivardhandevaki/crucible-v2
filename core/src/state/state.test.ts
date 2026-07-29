import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_VERIFY_SUMMARY_PREFIX,
  appendStateEvent,
  localVerifyRecorded,
  parseState,
  serializeState,
} from './state.js';

// TCB-adjacent: state.yaml is the derived audit trail (invariant 1 — never read
// to gate). P2-11 adds two things this suite pins: transcript indexing (an event
// may carry the transcript path of the session that produced it) and the
// `local_verify_ran` trajectory stamp derived from the events (advise-level,
// best-effort — a parked check that never blocks, so an absent/malformed log is
// treated as "not run" rather than thrown).

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-state-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('state — transcript indexing (P2-11)', () => {
  it('round-trips an event carrying a transcript path', () => {
    const path = join(scratch, 'state.yaml');
    appendStateEvent(
      path,
      'add-greeting',
      {
        at: '2026-07-29T00:00:00Z',
        cmd: 'implement',
        summary: 'tasks.md generated',
        transcript: '.crucible/transcripts/add-greeting/implement-tasks-x.jsonl',
      },
      'implementing',
    );
    const state = parseState(serializeState(parseState(readBack(path), path)), path);
    expect(state.events[0]?.transcript).toBe(
      '.crucible/transcripts/add-greeting/implement-tasks-x.jsonl',
    );
  });

  it('the transcript field is optional — a P1-era event with no transcript still parses', () => {
    const path = join(scratch, 'state.yaml');
    appendStateEvent(
      path,
      'add-greeting',
      { at: '2026-07-29T00:00:00Z', cmd: 'propose', summary: 'bundle judged pass' },
      'proposed',
    );
    expect(parseState(readBack(path), path).events[0]?.transcript).toBeUndefined();
  });
});

describe('state — localVerifyRecorded (P2-11 trajectory stamp)', () => {
  it('absent state.yaml → false (best-effort, never throws)', () => {
    expect(localVerifyRecorded(join(scratch, 'nope.yaml'))).toBe(false);
  });

  it('malformed state.yaml → false (advise-level; the fail-closed on a corrupt log is status’s job)', () => {
    const path = join(scratch, 'state.yaml');
    writeFileSync(path, 'not: [valid: yaml: at all', 'utf8');
    expect(localVerifyRecorded(path)).toBe(false);
  });

  it('events without a local-verify summary → false', () => {
    const path = join(scratch, 'state.yaml');
    appendStateEvent(
      path,
      'add-greeting',
      { at: '2026-07-29T00:00:00Z', cmd: 'implement', summary: 'tasks.md generated' },
      'implementing',
    );
    expect(localVerifyRecorded(path)).toBe(false);
  });

  it('an event whose summary starts with the local-verify prefix → true', () => {
    const path = join(scratch, 'state.yaml');
    appendStateEvent(
      path,
      'add-greeting',
      {
        at: '2026-07-29T00:00:01Z',
        cmd: 'implement',
        summary: `${LOCAL_VERIFY_SUMMARY_PREFIX} pass`,
      },
      'implemented',
    );
    expect(localVerifyRecorded(path)).toBe(true);
  });
});

/** Read a file back as UTF-8 text (tiny helper so the tests read cleanly). */
function readBack(path: string): string {
  return readFileSync(path, 'utf8');
}
